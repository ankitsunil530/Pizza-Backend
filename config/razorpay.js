import Razorpay from "razorpay";
import dotenv from "dotenv";

dotenv.config();

const keyId = process.env.RAZORPAY_KEY_ID || "";
const keySecret = process.env.RAZORPAY_KEY_SECRET || "";
const configuredMode = (process.env.RAZORPAY_MODE || "auto").toLowerCase();

export const getRazorpayMode = () => {
  const detectedMode = keyId.startsWith("rzp_live_") ? "live" : keyId.startsWith("rzp_test_") ? "test" : "not_configured";
  const mode = configuredMode === "auto" ? detectedMode : configuredMode;

  return {
    mode,
    detectedMode,
    isConfigured: Boolean(keyId && keySecret),
    isLive: mode === "live" && detectedMode === "live",
    keyPrefix: keyId ? `${keyId.slice(0, 8)}...` : "missing",
  };
};

export const assertRazorpayReady = () => {
  const razorpayMode = getRazorpayMode();

  if (!razorpayMode.isConfigured) {
    throw new Error("Razorpay keys are missing. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.");
  }

  if (configuredMode === "live" && !keyId.startsWith("rzp_live_")) {
    throw new Error("RAZORPAY_MODE=live requires a live Razorpay key_id that starts with rzp_live_.");
  }

  return razorpayMode;
};

const razorpay = new Razorpay({
  key_id: keyId,
  key_secret: keySecret,
});

export default razorpay;
