// Runs inside the bridge container (see watchdog.sh): exits 0 when the Chat authorisation can still be refreshed.
// It only asks Google for a fresh access token - it posts and uploads nothing.
const { makeChatSender } = require('/app/chat-sender.js');
const chat = makeChatSender({ fetch, env: process.env, log: () => {} });
if (!chat.enabled) process.exit(0);
chat.accessToken(true).then(() => process.exit(0), () => process.exit(1));
