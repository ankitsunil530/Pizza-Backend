import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, "..");
const processEnvPath = path.resolve(process.cwd(), ".env");
const backendEnvPath = path.join(backendRoot, ".env");

// Load both common locations so `node server.js` from /backend and
// `node backend/server.js` from repo root behave the same.
dotenv.config({ path: processEnvPath, override: false });
dotenv.config({ path: backendEnvPath, override: false });
