// SPDX-License-Identifier: GPL-3.0-or-later
import {defineConfig, devices} from '@playwright/test';

const PORT = 8765;

export default defineConfig({
    testDir: '.',
    testMatch: /.*\.spec\.mjs/,
    fullyParallel: false,
    workers: 1,
    retries: 0,
    timeout: 120_000,
    reporter: [['list']],
    use: {
        baseURL: process.env.SITE_URL ?? `http://127.0.0.1:${PORT}/`,
        ...devices['Desktop Chrome'],
        acceptDownloads: true,
    },
    webServer: process.env.SITE_URL ? undefined : {
        command: `node tools/serve.mjs`,
        cwd: new URL('../..', import.meta.url).pathname,
        env: {PORT: String(PORT)},
        url: `http://127.0.0.1:${PORT}/`,
        reuseExistingServer: false,
    },
});
