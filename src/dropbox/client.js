import { Dropbox } from 'dropbox';
import { config } from '../config.js';

// Only initialize Dropbox client if credentials are available
let dbx = null;

if (config.dropbox.clientId && config.dropbox.clientSecret && config.dropbox.refreshToken) {
  dbx = new Dropbox({
    clientId: config.dropbox.clientId,
    clientSecret: config.dropbox.clientSecret,
    refreshToken: config.dropbox.refreshToken,
  });
}

export { dbx };
