// A hidden page whose only job is to play the notification sound (a service worker cannot play audio).
import { playSound } from './sounds.js';

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'skifut-play') playSound(msg.sound);
});
