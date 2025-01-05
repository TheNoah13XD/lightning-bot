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

const expandYouTubeShortLinks = async (shortUrls: string[]) => {
    const responses = await Promise.all(shortUrls.map(shortUrl => fetch(shortUrl, { redirect: 'follow' })));
    return responses.map(response => response.url);
};

const fetchSocialMediaData = async (platform: string, inputs: any[]) => {
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
        const runs = await Promise.all(inputs.map(input => client.actor(actorMap[platform]).call(input)));
        const items = await Promise.all(runs.map(run => client.dataset(run.defaultDatasetId).listItems()));
        return items.flatMap(item => item.items);
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
    if (emails.size > 0) {
        return Array.from(emails).map(email => ({ email, url }));
    }

    const combinedLinks = combineAndFilterLinks(socialIcons, links, emails);
    const socialLinks = separateLinks(combinedLinks);

    const usernameCache: { [key: string]: string[] } = {};
    const getUsernames = (platform: string) => {
        if (!usernameCache[platform]) {
            usernameCache[platform] = extractUsernames(socialLinks, platform);
        }
        return usernameCache[platform];
    };

    const instagramUsernames = getUsernames('instagram');
    const tiktokUsernames = getUsernames('tiktok');

    const twitterUrls = socialLinks.filter(link => link && link.url && (link.url.includes('x.com') || link.url.includes('twitter.com'))).map(link => link.url);
    const twitterStartUrls = twitterUrls.map(url => Array(5).fill(url)).flat();

    const youtubeUrls = socialLinks.filter(link => link && link.url && (link.url.includes('youtube') || link.url.includes('youtu.be'))).map(link => link.url);
    const expandedYouTubeUrls = await expandYouTubeShortLinks(youtubeUrls.filter(url => url.includes('youtu.be')));
    const youtubeStartUrls = [...youtubeUrls.filter(url => !url.includes('youtu.be')), ...expandedYouTubeUrls].map(url => ({ url, method: 'GET' }));

    if (instagramUsernames.length) {
        const instagramResult = await fetchSocialMediaData('instagram', instagramUsernames.map(username => ({ usernames: [username], resultsLimit: 1 })));
        const instagramEmails = Array.from(extractEmails(instagramResult[0]?.biography as string));
        if (instagramEmails.length > 0) {
            return instagramEmails.map(email => ({ email, url: instagramResult[0]?.url }));
        }
    }

    if (tiktokUsernames.length) {
        const tiktokResult = await fetchSocialMediaData('tiktok', tiktokUsernames.map(profile => ({ profiles: [profile], resultsPerPage: 1 })));
        const tiktokEmails = Array.from(extractEmails((tiktokResult[0] as any)?.authorMeta.signature as string));
        if (tiktokEmails.length > 0) {
            return tiktokEmails.map(email => ({ email, url: (tiktokResult[0] as any)?.authorMeta.profileUrl }));
        }
    }

    if (twitterStartUrls.length) {
        const twitterResult = await fetchSocialMediaData('twitter', twitterStartUrls.map(url => ({ startUrls: [url], getFollowers: false, getFollowing: false, getRetweeters: false })));
        const twitterEmails = Array.from(extractEmails(twitterResult[0]?.description as string));
        if (twitterEmails.length > 0) {
            return twitterEmails.map(email => ({ email, url: twitterResult[0]?.url }));
        }
    }

    if (youtubeStartUrls.length) {
        const youtubeResult = await fetchSocialMediaData('youtube', youtubeStartUrls.map(url => ({ startUrls: [url], maxResults: 1, maxResultStreams: 0, maxResultsShorts: 0 })));
        const youtubeEmails = Array.from(extractEmails(youtubeResult[0]?.channelDescription as string));
        if (youtubeEmails.length > 0) {
            return youtubeEmails.map(email => ({ email, url: youtubeResult[0]?.channelUrl }));
        }
    }

    return [];
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

        const result = platform === 'Instagram' ? await fetchSocialMediaData('instagram', [{ usernames: [username], resultsLimit: 1 }]) : await fetchSocialMediaData('tiktok', [{ profiles: [username], resultsPerPage: 1 }]);
        const biography = platform === 'Instagram' ? result[0]?.biography : (result[0] as any).authorMeta.signature;
        const emails = Array.from(extractEmails(biography));
        if (emails.length > 0) {
            for (const email of emails) {
                await Dataset.pushData({ email, url: result[0]?.url });
            }
            return;
        }

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
