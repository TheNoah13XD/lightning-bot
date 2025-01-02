import { Dataset, createPlaywrightRouter } from 'crawlee';
import { ApifyClient } from 'apify-client';
import dotenv from 'dotenv';
import { Page } from 'playwright';

dotenv.config();

const client = new ApifyClient({
    token: process.env.APIFY_TOKEN,
});

export const router = createPlaywrightRouter();

const extractProfileData = async (page: Page) => {
    return page.evaluate(() => {
        const socialIcons = Array.from(document.querySelectorAll('a[data-testid="SocialIcon"]')).map(icon => ({
            title: icon.getAttribute('title') || 'Unknown',
            url: icon.getAttribute('href') || 'Unknown',
        }));

        const links = Array.from(document.querySelectorAll('a[data-testid="LinkButton"]')).map(anchor => ({
            title: anchor.querySelector('p')?.innerText.trim() || 'Unknown',
            url: anchor.getAttribute('href') || 'Unknown',
        }));

        const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
        const emailsFromContent = new Set<string>((document.body.innerText.match(emailRegex) || []).map(email => email.trim()));

        return {
            socialIcons,
            links,
            emailsFromContent: Array.from(emailsFromContent),
        }
    });
};

const combineAndFilterLinks = (socialIcons: any[], links: any[], emails: Set<string>) => {
    const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;

    return [...socialIcons, ...links].filter(link => {
        if (link.url && emailRegex.test(link.url)) {
            emails.add(link.url.replace(/^mailto:/, '').trim());
            return false;
        }
        return true;
    });
};

const separateLinks = (combinedLinks: any[]) => {
    const socialMediaDomains = ['instagram', 'tiktok', 'twitter', 'x.com', 'youtube', 'youtu.be'];
    const isSocialMediaLink = (url: string) => socialMediaDomains.some(domain => url.includes(domain) || url.includes(`www.${domain}`));

    const socials = combinedLinks.filter(link => link.url && isSocialMediaLink(link.url));
    const socialLinks = Array.from(new Set(socials.map(link => JSON.stringify(link)))).map(link => JSON.parse(link));

    return socialLinks;
};

const extractUsernames = (uniqueSocialLinks: any[], platform: string) => {
    const regexMap: { [key: string]: RegExp } = {
        instagram: /instagram\.com\/([^/?#]+)/,
        tiktok: /tiktok\.com\/@([^/?#]+)/,
        twitter: /twitter\.com\/([^/?#]+)/,
        youtube: /youtube\.com\/([^/?#]+)/
    };

    const extractUsername = (url: string) => {
        const match = url.match(regexMap[platform]);
        return match ? match[1] : null;
    };

    return uniqueSocialLinks.reduce((usernames, link) => {
        const username = link && link.url ? extractUsername(link.url) : null;
        if (username) {
            usernames.push(username);
        }
        return usernames;
    }, [] as string[]);
};

const expandYouTubeShortLink = async (shortUrl: string) => {
    const response = await fetch(shortUrl, { redirect: 'follow' });
    return response.url;
};

const fetchSocialMediaData = async (platform: string, input: any) => {
    const actorMap: { [key: string]: string } = {
        instagram: "apify/instagram-profile-scraper",
        tiktok: "clockworks/tiktok-profile-scraper",
        twitter: "apidojo/twitter-user-scraper",
        youtube: "streamers/youtube-scraper",
    };

    if (!actorMap[platform]) {
        throw new Error(`Unsupported platform: ${platform}`);
    }

    try {
        const run = await client.actor(actorMap[platform]).call(input);
        const { items } = await client.dataset(run.defaultDatasetId).listItems();
        return items;
    } catch (error) {
        console.error(`Failed to fetch data for platform ${platform}:`, error);
        throw new Error(`Failed to fetch data for platform ${platform}`);
    }
};

const extractEmails = (text: string) => {
    if (!text) return new Set<string>();
    const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
    return new Set<string>((text.match(emailRegex) || []).map(email => email.trim()));
};

const extractLinktree = (text: string) => {
    if (!text) return new Set<string>();
    const linktreeRegex = /https?:\/\/(www\.)?linktr\.ee\/([^/?#]+)/g;
    return new Set<string>((text.match(linktreeRegex) || []).map(link => link.trim()));
}

const crawlLinktree = async (page: Page, url: string) => {
    const { socialIcons, links, emailsFromContent } = await extractProfileData(page);

    const emails: Set<string> = new Set(emailsFromContent);
    const combinedLinks = combineAndFilterLinks(socialIcons, links, emails);

    const socialLinks = separateLinks(combinedLinks);

    const [instagramUsernames, tiktokUsernames] = [
        extractUsernames(socialLinks, 'instagram'),
        extractUsernames(socialLinks, 'tiktok')
    ];

    const twitterUrls = socialLinks.filter(link => link && link.url && (link.url.includes('x.com') || link.url.includes('twitter.com'))).map(link => link.url);
    const twitterStartUrls = twitterUrls.map(url => Array(5).fill(url)).flat();

    const youtubeUrls = socialLinks.filter(link => link && link.url && (link.url.includes('youtube') || link.url.includes('youtu.be'))).map(link => link.url);
    const expandedYouTubeUrls = await Promise.all(youtubeUrls.map(url => url.includes('youtu.be') ? expandYouTubeShortLink(url) : url));
    const youtubeStartUrls = expandedYouTubeUrls.map(url => ({ url, method: 'GET' }));

    const [instagramResult, tiktokResult, twitterResult, youtubeResult] = await Promise.all([
        instagramUsernames.length ? fetchSocialMediaData('instagram', { usernames: instagramUsernames, resultsLimit: 1 }) : [],
        tiktokUsernames.length ? fetchSocialMediaData('tiktok', { profiles: tiktokUsernames, resultsPerPage: 1 }) : [],
        twitterStartUrls.length ? fetchSocialMediaData('twitter', { startUrls: twitterStartUrls, getFollowers: false, getFollowing: false, getRetweeters: false }) : [],
        youtubeStartUrls.length ? fetchSocialMediaData('youtube', { startUrls: youtubeStartUrls, maxResults: 1, maxResultStreams: 0, maxResultsShorts: 0 }) : [],
    ]);

    const instagramEmails = Array.from(extractEmails(instagramResult[0]?.biography as string));
    const tiktokEmails = Array.from(extractEmails((tiktokResult[0] as any)?.authorMeta.signature as string));
    const twitterEmails = Array.from(extractEmails(twitterResult[0]?.description as string));
    const youtubeEmails = Array.from(extractEmails(youtubeResult[0]?.channelDescription as string));

    const emailUrlPairs = [
        ...Array.from(emails).map(email => ({ email, url })),
        ...instagramEmails.map(email => ({ email, url: instagramResult[0]?.url })),
        ...tiktokEmails.map(email => ({ email, url: (tiktokResult[0] as any)?.authorMeta.profileUrl })),
        ...twitterEmails.map(email => ({ email, url: twitterResult[0]?.url })),
        ...youtubeEmails.map(email => ({ email, url: youtubeResult[0]?.channelUrl })),
    ];

    return emailUrlPairs;
}

const handlePlatform = async (platform: string, page: Page, url: string, log: any) => {
    if (platform === 'Linktree') {
        const emailUrlPairs = await crawlLinktree(page, url);
        for (const { email, url } of emailUrlPairs) {
            await Dataset.pushData({ email, url });
        }
    } else {
        const username = extractUsernames([{ url }], platform.toLowerCase())[0];

        if (!username) {
            log.error(`Failed to extract ${platform} username from ${url}`);
            return;
        }

        const result = platform === 'Instagram' ? await fetchSocialMediaData('instagram', { usernames: [username], resultsLimit: 1 }) : await fetchSocialMediaData('tiktok', { profiles: [username], resultsPerPage: 1 });
        const biography = platform === 'Instagram' ? result[0]?.biography : (result[0] as any).authorMeta.signature;
        const emails = Array.from(extractEmails(biography));

        const linktree = extractLinktree(biography);
        if (linktree.size) {
            const linktreeUrl = Array.from(linktree)[0];
            await page.goto(linktreeUrl, { waitUntil: 'domcontentloaded' });
            const emailUrlPairs = await crawlLinktree(page, linktreeUrl);
            const finalEmailUrlPairs = [
                ...emailUrlPairs,
                ...emails.map(email => ({ email, url: result[0]?.url }))
            ];

            for (const { email, url } of finalEmailUrlPairs) {
                await Dataset.pushData({ email, url });
            }
        }
    }
};

router.addDefaultHandler(async ({ request, page, log }) => {
    const url = request.url;
    let platform = '';

    if (/^https?:\/\/(www\.)?linktr\.ee/.test(url)) {
        platform = 'Linktree';
    } else if (/^https?:\/\/(www\.)?instagram\.com/.test(url)) {
        platform = 'Instagram';
    } else if (/^https?:\/\/(www\.)?tiktok\.com/.test(url)) {
        platform = 'TikTok';
    }

    if (platform) {
        await handlePlatform(platform, page, url, log);
    } else {
        log.error(`Unsupported platform: ${url}`);
    }
});