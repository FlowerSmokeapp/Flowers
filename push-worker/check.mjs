// Tjekker at bot-kontoen kan logge ind, og at Firestore-reglerne giver den adgang.
// Køres af GitHub Actions (cloudflare.yml); viser aldrig mail eller adgangskode.
const API_KEY = "AIzaSyAGS0JZBnrk5ozRrSgmypds9dNnnoBriyo";
const DOCS = "https://firestore.googleapis.com/v1/projects/flower-438b9/databases/(default)/documents";
const { PUSH_EMAIL, PUSH_PASSWORD } = process.env;

function fail(message) {
  console.log(`::error::${message}`);
  process.exit(1);
}

if (!PUSH_EMAIL || !PUSH_PASSWORD) fail("PUSH_EMAIL eller PUSH_PASSWORD mangler under Settings → Secrets → Actions");

const login = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: PUSH_EMAIL.trim(), password: PUSH_PASSWORD, returnSecureToken: true }),
}).then((r) => r.json());

if (!login.idToken) {
  const code = (login.error && login.error.message) || "ukendt fejl";
  // Hints uden at afsløre mail eller adgangskode
  const [user = "", domain = ""] = PUSH_EMAIL.trim().split("@");
  const hints = [
    `mail ligner ${user.slice(0, 1)}***@${domain || "(mangler @)"}`,
    /[A-ZÆØÅ]/.test(PUSH_EMAIL) ? "mailen har store bogstaver" : "",
    `adgangskoden er ${PUSH_PASSWORD.length} tegn`,
    /^[A-ZÆØÅ]/.test(PUSH_PASSWORD) ? "adgangskoden starter med STORT bogstav (iPhone gør ofte første bogstav stort)" : "",
    /\s/.test(PUSH_PASSWORD) ? "adgangskoden indeholder mellemrum eller linjeskift" : "",
    /[^\x20-\x7e]/.test(PUSH_PASSWORD) ? "adgangskoden har specialtegn (fx æ, ø, å eller iPhone-anførselstegn)" : "",
  ].filter(Boolean).join(" · ");
  console.log(`::warning::${hints}`);
  if (/INVALID_LOGIN_CREDENTIALS|INVALID_PASSWORD|EMAIL_NOT_FOUND/.test(code)) {
    fail(`Bot-login fejlede (${code}): mail eller adgangskode i secrets passer ikke med brugeren i Firebase`);
  }
  if (/PASSWORD_LOGIN_DISABLED|OPERATION_NOT_ALLOWED/.test(code)) fail(`Bot-login fejlede (${code}): slå Email/Password til under Authentication → Sign-in method`);
  fail(`Bot-login fejlede: ${code}`);
}
if (PUSH_PASSWORD !== PUSH_PASSWORD.trim()) console.log("::warning::Adgangskoden i PUSH_PASSWORD har mellemrum før eller efter");
console.log(`Bot-login virker. Bot-kontoens UID er: ${login.localId}`);

const queue = await fetch(`${DOCS}/pushQueue?pageSize=1`, { headers: { Authorization: `Bearer ${login.idToken}` } });
if (!queue.ok) {
  fail(`Bot-kontoen må ikke læse pushQueue. Tjek at "${login.localId}" står i stedet for BOT_UID i Firestore-reglerne, og tryk Publish`);
}
console.log("::notice::Alt virker: bot-kontoen kan logge ind og læse notifikationskøen");
