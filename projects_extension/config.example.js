// Local configuration — COPY this file to `config.js` and paste your real key there.
//
// `config.js` is gitignored so your API key never gets committed/pushed to the shared
// repo. The background service worker loads it via importScripts('config.js').

self.OPENAI_API_KEY = 'PASTE_YOUR_OPENAI_API_KEY_HERE';
self.SIMULATOR_MODEL = 'gpt-4o-mini';

// Optional: set to false to skip the second-pass draft verification (saves one API
// call per turn). Defaults to true when omitted.
// self.VERIFY_DRAFTS = false;
