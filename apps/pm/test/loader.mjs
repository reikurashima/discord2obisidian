import { register } from 'node:module';

// node --import ./test/loader.mjs ./test/run.mjs
register('./hooks.mjs', import.meta.url);
