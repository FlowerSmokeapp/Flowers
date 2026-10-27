// Sender push-notifikationer til telefonerne.
// Kører i GitHub Actions hvert 5. minut: logger ind som bot-kontoen,
// læser køen (pushQueue), sender til modtagernes telefoner (pushSubs)
// og sletter de sendte beskeder fra køen.
import webpush from "web-push";

const API_KEY = "AIzaSyAGS0JZBnrk5ozRrSgmypds9dNnnoBriyo";
const PROJECT = "flower-438b9";
const PUBLIC_KEY = "BCddMZ1dKlYPo9CdWxrjmrs1QyxwnmJ7gyQPWqDlkO-EOl96MrUSThl7oiB5LY4SiiqNewhoGXZLlECLP6fcLXI";
const DOCS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

const { PUSH_EMAIL, PUSH_PASSWORD, VAPID_PRIVATE } = process.env;
if (!PUSH_EMAIL || !PUSH_PASSWORD || !VAPID_PRIVATE) {
  console.log("Mangler secrets (PUSH_EMAIL, PUSH_PASSWORD, VAPID_PRIVATE). Springer over.");
  process.exit(0);
}
webpush.setVapidDetails("mailto:push@flower.app", PUBLIC_KEY, VAPID_PRIVATE);

const TEXT = {
  da: {
    chat: (n, t) => [n, t],
    request: (n) => ["Ny venneanmodning", `${n} vil gerne være venner`],
    accepted: (n) => ["I er nu venner", `${n} har accepteret din venneanmodning`],
    sesh: (n, t) => ["Sesh-invitation", `${n} inviterer til en sesh${t ? ` · ${t}` : ""}`],
    cheer: (n) => ["Du får et hep", `${n} hepper på din pause. Bliv ved!`],
    comment: (n, t) => [`${n} kommenterede dit opslag`, t],
    mention: (n, t) => [`${n} nævnte dig`, t],
    many: (k) => ["Flower", `Du har ${k} nye notifikationer`],
  },
  en: {
    chat: (n, t) => [n, t],
    request: (n) => ["New friend request", `${n} wants to be friends`],
    accepted: (n) => ["You're now friends", `${n} accepted your friend request`],
    sesh: (n, t) => ["Sesh invite", `${n} invites you to a sesh${t ? ` · ${t}` : ""}`],
    cheer: (n) => ["You got a cheer", `${n} is cheering on your break. Keep going!`],
    comment: (n, t) => [`${n} commented on your post`, t],
    mention: (n, t) => [`${n} mentioned you`, t],
    many: (k) => ["Flower", `You have ${k} new notifications`],
  },
};

// Firestore REST giver værdier som { stringValue: "..." } osv.
function plain(value) {
  if (!value) return undefined;
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("mapValue" in value) {
    const out = {};
    for (const [k, v] of Object.entries(value.mapValue.fields || {})) out[k] = plain(v);
    return out;
  }
  if ("arrayValue" in value) return (value.arrayValue.values || []).map(plain);
  return undefined;
}

function fields(doc) {
  return plain({ mapValue: { fields: doc.fields || {} } });
}

async function signIn() {
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: PUSH_EMAIL, password: PUSH_PASSWORD, returnSecureToken: true }),
  });
  const json = await res.json();
  if (!json.idToken) throw new Error("Kunne ikke logge ind som bot: " + JSON.stringify(json.error || json));
  return json.idToken;
}

async function main() {
  const token = await signIn();
  const api = (path, options = {}) =>
    fetch(DOCS + path, { ...options, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(options.headers || {}) } });

  const res = await api("/pushQueue?pageSize=300");
  const body = await res.json();
  if (!res.ok) throw new Error("Kunne ikke læse køen: " + JSON.stringify(body.error || body));
  const queue = (body.documents || []).map((d) => ({ name: d.name, ...fields(d) }));
  console.log(`${queue.length} i køen`);
  if (!queue.length) return;

  // Gruppér pr. modtager
  const byUser = new Map();
  for (const item of queue) {
    if (!item.to) continue;
    if (!byUser.has(item.to)) byUser.set(item.to, []);
    byUser.get(item.to).push(item);
  }

  let sent = 0;
  for (const [uid, items] of byUser) {
    const subRes = await api(`/pushSubs/${encodeURIComponent(uid)}`);
    if (!subRes.ok) continue; // ingen telefon tilmeldt
    const subs = fields(await subRes.json()).subs || {};
    for (const [key, sub] of Object.entries(subs)) {
      const L = TEXT[sub.lang] || TEXT.da;
      items.sort((a, b) => a.createdAt - b.createdAt);
      // Højst 3 enkelte notifikationer; flere bliver samlet til én
      const messages = items.length > 3
        ? [{ title: L.many(items.length)[0], body: L.many(items.length)[1], tag: "many" }]
        : items.map((it) => {
          const [title, text] = (L[it.type] || L.mention)(it.fromName || "?", it.text || "");
          return { title, body: text, tag: it.type === "chat" ? `chat-${it.ref}` : undefined };
        });
      for (const msg of messages) {
        try {
          await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(msg), { TTL: 86400 });
          sent++;
        } catch (error) {
          // Telefonen er afmeldt: fjern den
          if (error.statusCode === 404 || error.statusCode === 410) {
            await api(`/pushSubs/${encodeURIComponent(uid)}?updateMask.fieldPaths=subs.${key}`, {
              method: "PATCH",
              body: JSON.stringify({ fields: {} }),
            });
            break;
          }
          console.error("Push fejlede:", error.statusCode, error.body);
        }
      }
    }
  }

  // Slet det sendte fra køen
  for (const item of queue) {
    await fetch(`https://firestore.googleapis.com/v1/${item.name}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  }
  console.log(`Sendt ${sent} notifikationer`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
