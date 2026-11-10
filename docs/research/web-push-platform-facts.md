# Web Push platform facts

Research for [#4](https://github.com/natem-searidge/cohort-005-project/issues/4) (child of the map [#2](https://github.com/natem-searidge/cohort-005-project/issues/2)). Gathered 2026-11-10 from primary sources. Every claim cites the page that owns it. Items marked **UNCERTAIN** need a check on a real device before we rely on them.

Cadence stack at the time of writing (from `package.json`): `react-router` / `@react-router/dev` / `@react-router/serve` **8.3.0**, `vite` **^7.1.7**, `"type": "module"`, SSR on (`react-router.config.ts`). Production runs `react-router-serve ./build/server/index.js`.

## TL;DR: facts that constrain decisions

1. **iOS/iPadOS: push works only in a Home Screen web app** (iOS/iPadOS 16.4+). The site needs a web app manifest with `display: standalone` or `fullscreen`. In a Safari tab on iPhone, push is not available. An iOS user has to install Cadence before they can opt in, so the in-app inbox is the only channel for users who don't install. [WebKit 2023][wk-ios]
2. **Prompt only from a user gesture.** Safari (macOS and iOS) needs an explicit gesture to subscribe. Firefox 72+ turns gesture-less prompts into an address-bar icon. Chrome gives quiet UI and chips to sites with low accept rates, and Chrome 155 on Android uses a non-blocking prompt that can time out and leave the permission at `"default"`. Design: an in-context "Turn on notifications" button, never a prompt on page load. [WebKit 2022][wk-meet], [Mozilla][ff72], [Chromium 2020][cr-quiet], [Chrome 155 Android][cr-android]
3. **Every push must show a notification** (`userVisibleOnly: true`). Chrome rejects subscriptions without it. Safari revokes the push permission if a push doesn't show a notification. Silent or background pushes are not an option. [MDN subscribe][mdn-subscribe], [Apple][apple]
4. **Subscriptions die silently. The server is the source of truth for cleanup.** Delete the stored subscription on **404 or 410** from the push service. `pushsubscriptionchange` exists but **iOS Safari does not support it** (MDN BCD), Firefox's event lacks `oldSubscription`/`newSubscription`, and Chrome only added it in 138. So: re-sync the subscription on every app load as well. [web.dev][webdev-proto], [Apple][apple], [BCD][bcd-sw]
5. **Payload ≤ ~4 KB** (3993 bytes of plaintext after aes128gcm overhead). Send a small JSON payload (title, body, URL, ids). Never send full content. [RFC 8291 §4][rfc8291]
6. **Service worker = a plain JS file in `public/`** (for example `public/sw.js`). Vite serves it at `/sw.js` in dev and copies it into `build/client/` as-is. `react-router-serve` serves `build/client/` at `/` without long-term caching, so the scope is `/`. React Router has no built-in service worker support. [Vite][vite-public], `@react-router/serve` source
7. **`web-push` npm is now v4.0.0 (released 2026-11-06): ESM-only, Node ≥ 16.** It handles VAPID JWT signing and payload encryption. It does **not** store keys, store subscriptions, retry, or clean up. `@types/web-push` is still at 3.6.4 (**UNCERTAIN** whether it matches 4.0's API exactly). [npm][npm-wp], [web-push README][wp]

---

## 1. Browser and OS support

| Platform | Push support | Notes |
|---|---|---|
| Chrome / Edge desktop & Android | Chrome 42+ (payload 50+), Edge 17+ | Endpoints on FCM (`fcm.googleapis.com`). [web-push README][wp] |
| Firefox desktop & Android | 44+ | Mozilla autopush. [web-push README][wp] |
| Safari macOS | Safari 16 on **macOS 13 Ventura+** | Standards-based (VAPID). No Apple Developer account needed. [WebKit 2022][wk-meet], [Apple][apple] |
| Safari iOS/iPadOS | **16.4+, Home Screen web apps only** | Needs a manifest with `display: standalone`/`fullscreen`. Otherwise "Add to Home Screen" makes a plain bookmark that opens in the browser. [WebKit 2023][wk-ios] |
| Third-party iOS browsers (Chrome/Firefox on iOS) | Not in a tab | They use WebKit, so the Home Screen rule applies. **UNCERTAIN**: on recent iOS versions, other browsers can also add Home Screen web apps. Verify on a device. |

iOS extras (WebKit 2023): the Badging API (`navigator.setAppBadge`/`clearAppBadge`) works in Home Screen apps, including from a push handler, and even before notification permission is granted. Notifications follow Focus modes. Focus sync across devices uses the manifest `id` member. Allow `*.push.apple.com` if the server restricts outbound URLs. [WebKit 2023][wk-ios], [Apple][apple]

**Declarative Web Push** (WebKit, 2025-03-27; iOS/iPadOS 18.4, macOS 15.5). The push payload carries `"web_push": 8030` and a `notification` object with a required `title` and `navigate` URL, optional `body` and `app_badge`. The browser displays it with no service worker code. A service worker can still adjust it, and the declarative content is the fallback if that fails. Older browsers handle the same message through the normal `push` event, so one payload format serves both. **UNCERTAIN**: the post doesn't say whether it lifts the iOS Home Screen requirement. Assume it doesn't. [WebKit DWP][wk-dwp]

## 2. VAPID (RFC 8292) and what `web-push` handles

- **Generation:** `webpush.generateVAPIDKeys()` returns URL-safe base64 `{ publicKey, privateKey }` (P-256). CLI: `npx web-push generate-vapid-keys [--json]`. The README says to generate the keys **once** and reuse them. [web-push README][wp]
- **Configuration:** `webpush.setVapidDetails(subject, publicKey, privateKey)`. `subject` must be `mailto:` or `https:`. The README warns that a localhost subject can be rejected by Apple with `403 BadJwtToken`. Apple also rejects JWTs whose `exp` is more than 24 h ahead, and asks senders not to refresh the JWT more than once an hour. [web-push README][wp], [Apple][apple]
- **Storage:** keep the private key server-side only (env var or secret). The public key goes to the client as `applicationServerKey`. This is a key-handling inference, not a quote from a source.
- **Rotation is expensive.** Each subscription is bound to the `applicationServerKey` it was created with: "If specified, all messages from your application server must use the VAPID authentication scheme, and include a JWT signed with the corresponding private key." [MDN subscribe][mdn-subscribe]. Calling `subscribe()` with a different key while a subscription exists rejects with `InvalidStateError` (Push API spec, `subscribe()` step 11.6.3) [Push API][w3c-push]. So rotation means each client must `unsubscribe()` and then `subscribe()` again with the new key, and the server must keep the old key working until every client has resubscribed. Practically: treat the keys as long-lived and plan to rotate only after a compromise.
- **What `web-push` does:** builds the VAPID JWT and Authorization headers, encrypts the payload (`aes128gcm` by default, `aesgcm` optional) when the subscription has `p256dh`/`auth` keys, and POSTs to the endpoint. Options: `TTL` (default **4 weeks**), `urgency` (`very-low|low|normal|high`), `topic` (≤32 base64url characters, coalesces messages), `headers`, `timeout`, `proxy`/`agent`. On failure the promise rejects with an error carrying `statusCode`, `headers`, `body`. `generateRequestDetails()` returns the request without sending it, which is useful for tests. [web-push README][wp]
- **What it doesn't do:** persist keys or subscriptions, retry or back off on 429, delete subscriptions on 404/410, queue or fan out sends. Cadence owns all of these.
- **v4.0.0 (2026-11-06)**, per the `v3.6.7...v4.0.0` commits: "migrate to ESM-only", "move to classes rather than prototypes", CLI switched to `parseArgs`, dependency refresh. `package.json`: `"type": "module"`, `engines.node >= 16`. Cadence is already `"type": "module"`, so ESM-only is fine. No bundled TypeScript types. `@types/web-push@3.6.4` targets 3.x. **UNCERTAIN** whether the 3.x types still match 4.0 exactly. [npm][npm-wp], [GitHub compare][wp-compare]

## 3. Payload size, encryption, and notification contents

- **Size:** a push service must accept bodies of at least 4096 bytes and may return `413` above that (RFC 8030 §7.2). aes128gcm adds 86 bytes of header, at least 1 byte of padding, and a 16-byte tag, which leaves **at most 3993 bytes of plaintext** (RFC 8291 §4). Apple: "over the limit of 4 KB" gives `413 PayloadTooLarge`. Mozilla's obsolete autopush docs say 4028 characters, or 2744 through a GCM bridge. **Design for ≤ ~2–3 KB JSON.** [RFC 8030][rfc8030], [RFC 8291][rfc8291], [Apple][apple], [autopush][autopush]
- **Encryption** is mandatory for payloads (RFC 8291, ECDH P-256 + HKDF + AES-128-GCM) and `web-push` handles it.
- **Delivery headers** (RFC 8030): `TTL` is required (`0` means deliver now or drop), `Urgency` defaults to `normal`, and `Topic` replaces an undelivered message with the same topic. `201` means the push service accepted the message, not that it was delivered. [RFC 8030][rfc8030]
- **Notification options** (WHATWG Notifications spec): `title` (an argument), `body`, `icon`, `badge`, `image`, `tag`, `renotify`, `requireInteraction`, `silent`, `timestamp`, `data`, `actions`, `dir`, `lang`, and a newer `navigate` URL. `maxActions` is implementation-defined. [WHATWG][whatwg-notif]
- **Support varies widely** (MDN BCD, `api.Notification.*`):

  | Option | Chrome | Firefox | Safari macOS / iOS |
  |---|---|---|---|
  | `data` | 44 | 34 | 16 / 16.4 yes |
  | `icon` | 33 | 26 | no (settable, no effect; site icon is used) |
  | `tag` | 20 | 26 | no (no effect) |
  | `actions` | 53 | 152 | no |
  | `image` | 56 | no | no |
  | `badge` | 53 | no | no |
  | `requireInteraction` | 47 | Windows only | no |

  Safe cross-browser baseline: **title + body + data (with a deep-link URL)**. Treat icon, actions, image, and tag as Chromium-only extras. [BCD][bcd-notif]
- **Deep links:** put the URL in `data.url` and, in the `notificationclick` handler, call `clients.matchAll()`, then focus an existing tab or `clients.openWindow(url)`. Declarative Web Push uses `navigate` instead. **UNCERTAIN**: MDN BCD lists `notificationclick` as `false` for iOS Safari while supporting `push` and `data` on iOS 16.4. That's probably a data gap, since Apple's docs describe handling clicks, but test deep links on a real iPhone. [BCD][bcd-sw]

## 4. Subscription lifecycle

- **Contents:** `endpoint` (a secret capability URL: "knowledge of the endpoint is all that is necessary to send a message"), `keys.p256dh`, `keys.auth`, and `expirationTime` (often `null`). Store all of them for each device or user. Protect the subscribe endpoint against CSRF. [MDN Push API][mdn-push]
- **`expirationTime`:** the UA "SHOULD attempt to refresh the push subscription before the subscription expires" [Push API][w3c-push]. Supported in Chrome 60+, Firefox 96+, Safari 16 / iOS 16.4 [BCD][bcd-sub]. Usually `null`, so we can't rely on it.
- **Dead subscriptions, by status code from the push service:**
  - `404`: expired, delete it (RFC 8030 §7.3; web.dev). Autopush: "invalid and should not be used again".
  - `410`: "no longer valid and should be removed" (web.dev, autopush). Apple: "The device token has expired".
  - `413`: payload too large. `429`: rate-limited, honour `Retry-After`. `400`/`403`: our bug (headers or VAPID JWT). Don't delete on these.
  [web.dev][webdev-proto], [Apple][apple], [autopush][autopush], [RFC 8030][rfc8030]
- **`pushsubscriptionchange`:** fires in the service worker when the subscription is refreshed, revoked, or lost outside the app's control. The spec gives `oldSubscription` and `newSubscription` (the latter `null` if it couldn't be re-established). Support: Chrome **138+**, Firefox 44+ (but **without** `oldSubscription`/`newSubscription`), Safari macOS 16+, **iOS Safari: not supported**. Not Baseline. [MDN][mdn-psc], [BCD][bcd-sw], [Push API][w3c-push]
  - Consequence: on each app load (when permission is `granted`), call `registration.pushManager.getSubscription()`, resubscribe if it's `null`, and upsert it to the server, keyed by endpoint. Treat `pushsubscriptionchange` as a bonus.
- **Revocation by the browser:** Safari revokes the push permission if a push doesn't show a notification [Apple][apple]. Chrome (from Oct 2025) auto-revokes notification permission on sites with very low engagement and high notification volume. **Installed web apps are exempt** [Chromium blog][cr-revoke]. Chrome (from Jan 2026) rate-limits "disruptive" sites to as little as 1000 messages/min with `429`, but "Nearly all websites will be unaffected" [Chrome rate limits][cr-rate]. Firefox gives push messages that show no notification a quota, refreshed on each visit [MDN Push API][mdn-push].

## 5. Permission prompt rules

- **Requirements:** a secure context (HTTPS; `localhost` counts as potentially trustworthy in browsers). The Push API spec rejects non-`https` scopes with `NotAllowedError`. Chrome and Firefox also block requests from cross-origin iframes. [MDN requestPermission][mdn-reqperm], [Push API][w3c-push]
- **User gesture:**
  - Safari macOS and iOS: "requesting a push subscription requires an explicit user gesture". Apple: "call the push subscription method immediately from the gesture's event handler code". So **don't `await` network calls between the click and `subscribe()`** (or `requestPermission()`). Get the VAPID public key before the click, for example from a loader. [WebKit 2022][wk-meet], [Apple][apple], [WebKit 2023][wk-ios]
  - Firefox 72+: without user interaction, the prompt shrinks to an address-bar icon. [Mozilla][ff72]
  - MDN: "`subscribe()` calls should be done in response to a user gesture … going forward browsers will explicitly disallow notifications not triggered in response to a user gesture." [MDN subscribe][mdn-subscribe]
- **Penalties for prompting on load:** Chrome 80+ "quieter permission UI" for sites with low accept rates, with automatic enrollment of abusive or low-acceptance sites [Chromium 2020][cr-quiet]. Chrome 98+ permission chip: a gesture-less request becomes a chip that collapses on its own [Chrome chip][cr-chip]. Chrome 155 Android (2026-07-22): a non-blocking prompt that "will run with permission='default' if the non-blocking permission prompt times out". The post advises monitoring `navigator.permissions.query({name:'notifications'})` `onchange`, and says "Asking for notification permissions the moment a page loads can create immediate friction" [Chrome Android][cr-android]. Chrome also publishes notification accept rates in CrUX [CrUX][cr-crux].
- **Return values:** `Notification.requestPermission()` resolves to `granted | denied | default`, and `default` is treated as denied. The callback form is deprecated. [MDN requestPermission][mdn-reqperm]
- **After a denial:** the result resolves from the stored permission state (WHATWG §3.3 defers to the Permissions spec). In practice browsers don't re-prompt once the state is `denied`, and only the user can undo it in browser or OS settings (iOS: Settings → Notifications → the app). **UNCERTAIN**: the exact "no re-prompt" wording isn't in the pages we fetched. The behaviour is well established, but verify it per browser. Design implication: show our own pre-prompt ("Get notified when…?") and call the real API only after the user clicks yes. When the state is `denied`, show instructions instead of the button. [WHATWG][whatwg-notif], [MDN requestPermission][mdn-reqperm]

## 6. Service worker in React Router 8.3 / Vite 7

React Router has **no first-party service worker or PWA API**. We found no official docs page. A maintainer comment says it's safe to precache `build/client` because asset filenames are versioned ([discussion #12620][rr-12620]). The rest of this section comes from Vite docs and from the installed `@react-router/serve@8.3.0` source.

- **Where the file goes:** `public/sw.js` (plain JS, which Vite doesn't transform). Vite: public assets are "served at root path `/` during dev, and copied to the root of the dist directory as-is", without hashing. React Router's client build dir is `build/client/`, so it ships as `build/client/sw.js`. [Vite][vite-public]
- **Scope:** serving it at `/sw.js` gives the default max scope `/`, which covers the whole app. No `Service-Worker-Allowed` header is needed.
- **Production serving** (`node_modules/@react-router/serve/dist/cli.js`): `/assets/*` gets `immutable, maxAge: 1y`. The rest of `build/client` (including `sw.js` and the manifest) is served by `express.static` with default caching (max-age 0). A fallback `express.static("public", { maxAge: "1h" })` comes after it. So `sw.js` isn't long-cached, which is good for updates. Browsers also check the top-level SW script against the network by default (`updateViaCache: 'imports'`).
- **Registration:** call `navigator.serviceWorker.register('/sw.js')` in a client-only effect (for example `useEffect` in `root.tsx`), never during SSR. Feature-detect with `'serviceWorker' in navigator && 'PushManager' in window`. On iOS outside a Home Screen app, `PushManager` is missing, so show the "Add to Home Screen first" guidance. Detect standalone mode with `matchMedia('(display-mode: standalone)')` or `navigator.standalone`. (These are standard APIs. The pattern is our inference, not quoted.)
- **Dev:** `react-router dev` (Vite) serves `public/sw.js` at `/sw.js`. `http://localhost` is a secure context, so push subscriptions work in desktop Chrome and Firefox against the real push services. **UNCERTAIN**: testing on an iPhone needs HTTPS on a reachable host (a tunnel or deploy) plus Home Screen install. Plain LAN `http://` won't work. Remember to unregister or bypass the SW in DevTools during dev, since a stale SW can serve old code if we add fetch caching. A push-only SW with no `fetch` handler avoids most of that risk.
- **TypeScript SW:** files in `public/` aren't compiled. If we want a TS SW, we'd need a separate build step (e.g. a small Vite/esbuild entry writing to `public/` or `build/client/`). Recommendation: keep the SW tiny and in plain JS (`push`, `notificationclick`, `pushsubscriptionchange` handlers).
- **Manifest (needed for iOS):** `public/manifest.webmanifest` with `name`, `id`, `start_url`, `display: "standalone"`, and icons, linked from `root.tsx` `links` (`{ rel: "manifest", href: "/manifest.webmanifest" }`). [WebKit 2023][wk-ios]

## Open items / UNCERTAIN

- Whether `@types/web-push@3.6.4` is accurate for `web-push@4.0.0`.
- Whether `notificationclick` deep links work on iOS. BCD says no, which is likely a data gap.
- Whether Declarative Web Push changes the iOS Home Screen requirement (assume not).
- Exact browser wording for "no re-prompt after denied".
- Whether non-Safari iOS browsers can install Home Screen web apps with push (iOS version dependent).

## Sources

- [wk-ios]: WebKit, "Web Push for Web Apps on iOS and iPadOS", 2023-02-16 — https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- [wk-meet]: WebKit, "Meet Web Push", 2022-06-07 — https://webkit.org/blog/12945/meet-web-push/
- [wk-dwp]: WebKit, "Meet Declarative Web Push", 2025-03-27 — https://webkit.org/blog/16535/meet-declarative-web-push/
- [apple]: Apple Developer, "Sending web push notifications in web apps and browsers" — https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers
- [rfc8030]: RFC 8030, Generic Event Delivery Using HTTP Push — https://www.rfc-editor.org/rfc/rfc8030.html
- [rfc8291]: RFC 8291, Message Encryption for Web Push — https://www.rfc-editor.org/rfc/rfc8291.html
- [w3c-push]: W3C Push API (editor's draft) — https://w3c.github.io/push-api/
- [whatwg-notif]: WHATWG Notifications API — https://notifications.spec.whatwg.org/
- [mdn-push]: MDN, Push API — https://developer.mozilla.org/en-US/docs/Web/API/Push_API
- [mdn-subscribe]: MDN, PushManager.subscribe() — https://developer.mozilla.org/en-US/docs/Web/API/PushManager/subscribe
- [mdn-psc]: MDN, pushsubscriptionchange — https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerGlobalScope/pushsubscriptionchange_event
- [mdn-reqperm]: MDN, Notification.requestPermission() — https://developer.mozilla.org/en-US/docs/Web/API/Notification/requestPermission_static
- [bcd-sw] / [bcd-notif] / [bcd-sub]: MDN browser-compat-data (main, fetched 2026-11-10) — `api/ServiceWorkerGlobalScope.json`, `api/Notification.json`, `api/PushSubscription.json` at https://github.com/mdn/browser-compat-data
- [wp]: web-push README — https://github.com/web-push-libs/web-push
- [wp-compare]: web-push v3.6.7...v4.0.0 — https://github.com/web-push-libs/web-push/compare/v3.6.7...v4.0.0
- [npm-wp]: npm registry `web-push` (4.0.0, published 2026-11-06) — https://www.npmjs.com/package/web-push
- [webdev-proto]: web.dev, "The Web Push Protocol" — https://web.dev/articles/push-notifications-web-push-protocol
- [autopush]: Mozilla autopush HTTP API (marked obsolete) — https://autopush.readthedocs.io/en/latest/http.html
- [ff72]: Mozilla, "Restricting Notification Permission Prompts in Firefox", 2019-11-04 — https://blog.mozilla.org/futurereleases/2019/11/04/restricting-notification-permission-prompts-in-firefox/
- [cr-quiet]: Chromium Blog, "Introducing quieter permission UI for notifications", 2020-01 — https://blog.chromium.org/2020/01/introducing-quieter-permission-ui-for.html
- [cr-chip]: Chrome for Developers, "Permissions request chip" — https://developer.chrome.com/blog/permissions-chip
- [cr-android]: Chrome for Developers, "Lighter notification prompts on Android", 2026-07-22 — https://developer.chrome.com/blog/notification-prompts-android
- [cr-revoke]: Google, "Automatic notification permission revocation", 2025-10-10 — https://blog.google/chromium/automatic-notification-permission/
- [cr-rate]: Chrome for Developers, "Increasing web push notification value with rate limits", 2026-01-06 — https://developer.chrome.com/blog/web-push-rate-limits
- [cr-crux]: Chrome for Developers, "Notification permission data in CrUX" — https://developer.chrome.com/blog/notification-permission-data-in-crux
- [vite-public]: Vite, Static Asset Handling → The public Directory — https://vite.dev/guide/assets
- [rr-12620]: remix-run/react-router discussion #12620 — https://github.com/remix-run/react-router/discussions/12620
- `@react-router/serve@8.3.0` `dist/cli.js` (installed in this repo), lines 113–120.

[wk-ios]: https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
[wk-meet]: https://webkit.org/blog/12945/meet-web-push/
[wk-dwp]: https://webkit.org/blog/16535/meet-declarative-web-push/
[apple]: https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers
[rfc8030]: https://www.rfc-editor.org/rfc/rfc8030.html
[rfc8291]: https://www.rfc-editor.org/rfc/rfc8291.html
[w3c-push]: https://w3c.github.io/push-api/
[whatwg-notif]: https://notifications.spec.whatwg.org/
[mdn-push]: https://developer.mozilla.org/en-US/docs/Web/API/Push_API
[mdn-subscribe]: https://developer.mozilla.org/en-US/docs/Web/API/PushManager/subscribe
[mdn-psc]: https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerGlobalScope/pushsubscriptionchange_event
[mdn-reqperm]: https://developer.mozilla.org/en-US/docs/Web/API/Notification/requestPermission_static
[bcd-sw]: https://github.com/mdn/browser-compat-data/blob/main/api/ServiceWorkerGlobalScope.json
[bcd-notif]: https://github.com/mdn/browser-compat-data/blob/main/api/Notification.json
[bcd-sub]: https://github.com/mdn/browser-compat-data/blob/main/api/PushSubscription.json
[wp]: https://github.com/web-push-libs/web-push
[wp-compare]: https://github.com/web-push-libs/web-push/compare/v3.6.7...v4.0.0
[npm-wp]: https://www.npmjs.com/package/web-push
[webdev-proto]: https://web.dev/articles/push-notifications-web-push-protocol
[autopush]: https://autopush.readthedocs.io/en/latest/http.html
[ff72]: https://blog.mozilla.org/futurereleases/2019/11/04/restricting-notification-permission-prompts-in-firefox/
[cr-quiet]: https://blog.chromium.org/2020/01/introducing-quieter-permission-ui-for.html
[cr-chip]: https://developer.chrome.com/blog/permissions-chip
[cr-android]: https://developer.chrome.com/blog/notification-prompts-android
[cr-revoke]: https://blog.google/chromium/automatic-notification-permission/
[cr-rate]: https://developer.chrome.com/blog/web-push-rate-limits
[cr-crux]: https://developer.chrome.com/blog/notification-permission-data-in-crux
[vite-public]: https://vite.dev/guide/assets
[rr-12620]: https://github.com/remix-run/react-router/discussions/12620
