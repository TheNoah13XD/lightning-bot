import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import { router } from './routes.js';

interface Input {
    startUrls: string[];
    maxRequestsPerCrawl: number;
}

await Actor.init();

const {
    startUrls = ['https://linktr.ee/whonoahexe'],
    maxRequestsPerCrawl = 100,
} = await Actor.getInput<Input>() ?? {} as Input;

const proxyConfiguration = await Actor.createProxyConfiguration();

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl,
    requestHandler: router,
    requestHandlerTimeoutSecs: 400,
    maxRequestRetries: 5,
    headless: true,
    minConcurrency: 3,
});

await crawler.run(startUrls);

await Actor.exit();
