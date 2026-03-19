function timestamp() {
  return new Date().toISOString();
}

export const logger = {
  info(msg) {
    console.log(`[${timestamp()}] [INFO] ${msg}`);
  },
  warn(msg) {
    console.warn(`[${timestamp()}] [WARN] ${msg}`);
  },
  error(msg, error) {
    console.error(`[${timestamp()}] [ERROR] ${msg}`);
    if (error) console.error(error);
  },
};
