// Checks the OAuth 1.0a signer against X's published example (docs: "Creating a signature").
import { oauthHeader } from "../src/x.js";
const env = { X_API_KEY: "xvz1evFS4wEEPTGEFPHBog", X_API_SECRET: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
  X_ACCESS_TOKEN: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb", X_ACCESS_SECRET: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE" };
const h = await oauthHeader(env, "POST", "https://api.twitter.com/1.1/statuses/update.json?include_entities=true",
  { status: "Hello Ladies + Gentlemen, a signed OAuth request!" },
  { nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg", timestamp: "1318622958" });
const sig = decodeURIComponent(h.match(/oauth_signature="([^"]+)"/)[1]);
console.log(sig === "hCtSmYh+iHYCEqBWrE7C7hYmtUk=" ? "PASS oauth signature matches X's example" : `FAIL got ${sig}`);
