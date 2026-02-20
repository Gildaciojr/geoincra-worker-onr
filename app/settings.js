import process from "process";

export const SETTINGS = {
  DATABASE_URL: process.env.DATABASE_URL,

  DATA_DIR: process.env.DATA_DIR || "/data",
  BACKEND_UPLOADS_BASE: process.env.BACKEND_UPLOADS_BASE || "/app/app/uploads",

  ONR_PFX_PATH: process.env.ONR_PFX_PATH,
  ONR_PFX_PASSWORD: process.env.ONR_PFX_PASSWORD,

  POLL_INTERVAL_MS: 5000
};
