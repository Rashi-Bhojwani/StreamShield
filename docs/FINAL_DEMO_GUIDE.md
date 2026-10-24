> Current primary scope is four scenarios: API, video gateway, edge and network. See [current repair and actual verification limits](FOUR_SCENARIO_REPAIR_RESULTS.md). The earlier scope/results below are historical.

# StreamShield final demo guide (Hinglish)

> **Current one-run repair:** the five primary choices are `crash-api`, `crash-redis`, `crash-video-gateway`, `network-timeout` and `traffic-surge`. See [current repair, evidence, limitations and Windows commands](ONE_RUN_REPAIR_RESULTS.md). Earlier scenario rankings, instructions and measurements below describe the previous extended demonstration; they are historical evidence, not a passing run of this repair. For configuration-preserving troubleshooting, use the new guide rather than `final:up`.

Yeh guide aapko poora demo chalane mein madad karegi: system kya hai, kaise
kaam karta hai, aur stage par exactly kya bolna aur dikhana hai.

## 1. StreamShield kya hai — simple words mein

- **Users kya karte hain:** sign up karte hain, apna channel banate hain, Studio
  se camera/screen (browser) ya OBS se live jaate hain. Doosre log Home/Live page
  par stream dhoondte hain, Watch page par video dekhte hain aur chat karte hain.
- **Live streaming kaise chalta hai:** broadcaster ka video **ingest relay
  (MediaMTX)** tak jaata hai — browser se WHIP, OBS se RTMP. Relay se **primary**
  aur **standby origin** video lete hain aur HLS segments (2-second ke chhote
  tukde) banate hain. **Edge-1/Edge-2** in segments ko cache karte hain, aur
  **video gateway** se viewers tak pahunchte hain.
- **API server kya karta hai:** login, channels, stream list, chat. Do API
  servers hain (API-1, API-2); ek spare API-3 bhi ready rakha hai jo sirf
  Healer chalata hai.
- **Redis:** chat ko dono API servers ke beech pahunchata hai (Socket.IO bus),
  presence aur rate limits rakhta hai. **PostgreSQL** mein data aur chat history.
- **Redundancy:** do API, do edge, primary + standby origin — ek gir jaye to
  doosra kaam sambhal leta hai (failover). Lekin Redis, video gateway aur relay
  akele hain — wahan failover nahi hai, isliye wahan healing aur bhi zaroori hai.

## 2. Observer, Healer, dashboard — kaun kya karta hai

- **Observer:** har 2 second har component ko probe karta hai. Do baar lagatar
  fail = confirmed failure. Woh farq karta hai:
  - `probe_unreachable` — process mar gaya (connection refused / naam hi nahi mila)
  - `probe_timeout` — process zinda hai par jawab nahi deta (hang)
  - API tier par load: p95 latency 1.2 s se upar 3 samples tak = `overloaded`
- **Healer:** sirf Observer ke symptoms dekhta hai — use cause kabhi nahi bataya
  jaata. Symptom ke hisaab se playbook chunta hai: mara hua → **start**, hung →
  **restart**, overload → **spare API-3 start (scale-out)**. Har action ek chhote
  "healing-control" adapter se hota hai jiske paas hi Docker ka access hai, aur
  woh sirf allowlist wale kaam karta hai. Budget: ek service par 10 minute mein
  max 2 operations, 30 s cooldown.
- **Verification:** "container running hai" kaafi nahi. Healer asli kaam check
  karta hai — API se real data, gateway se asli advancing video segments, Redis
  PING, relay ke RTMP/WHIP listeners.
- **Dashboard proof:** `/control/presentation` par har stage tabhi jalta hai jab
  uska asli timestamp database mein hai. `/control/analysis` par green → red →
  blue → green history. Terminal mein `npm run final:watch` container ka
  `StartedAt` aur uptime dikhata hai — naya StartedAt = asli restart hua.

**Rang ka matlab (har jagah same):** ✓ green = healthy · ▲ amber = degraded / backup par
· ✕ red = failed · ⟳ blue = healing · ✓✓ green outline = verified recovered ·
! purple = escalated (insaan chahiye) · ? grey = data nahi · ϟ magenta = fault inject hua.

## 3. Kya heal NAHI ho sakta (seedha bolna hai)

- Camera/OBS band ho gaya → server us broadcaster ka camera wapas nahi la sakta.
  (Isliye "broadcaster interruption" disabled hai.)
- Database corruption/outage → Healer kabhi DB ko start/reset/migrate nahi karta;
  operator review ke liye escalate karta hai.
- Budget khatam → Healer ruk kar purple escalation dikhata hai, loop mein restart nahi.
- Ek hi Docker host hai — poori machine band to sab band.

## 4. Windows setup (pehli baar)

Docker Desktop (Linux containers) chalu karein — kam se kam 4 CPU, 8 GB RAM,
25 GB disk. Node.js 24. PowerShell kholiye:

```powershell
git clone https://github.com/Rashi-Bhojwani/StreamShield.git
cd StreamShield
git checkout feature/final-self-healing-presentation
npm.cmd ci
npm.cmd run final:up          # setup + build + start + chaos probe (volumes kabhi delete nahi)
npm.cmd run dynamic:status
```

`final:up` spare API-3 ko _created (stopped)_ state mein banata hai. Agar aapne
pehle `dynamic:up` chalaya tha to ek baar yeh bhi chalayein:

```powershell
node infrastructure/dynamic/compose.mjs --profile spare create api-3
```

Admin role do (Rashi ko):

```powershell
node infrastructure/dynamic/compose.mjs exec -T api-2 node scripts/set-role.mjs rashi administrator
```

Band karna: `npm.cmd run final:down` (kabhi `-v` nahi, kabhi volumes prune nahi).
`npm run dev` ko port 5173 par Docker web ke saath kabhi mat chalayein.

### Do Chrome profiles

1. Chrome → profile icon → **Add** → "Rashi" (broadcaster + admin).
2. Phir **Add** → "Lakshita" (viewer). Alag profile = alag cookies = do asli users.
3. Dono mein http://127.0.0.1:5173/signup se account banayein.

### Doosre device se OBS (trusted LAN)

```powershell
npm.cmd run setup:dynamic -- --enable-local-chaos --ingest-host 192.168.1.20   # aapka LAN IP
npm.cmd run dynamic:up
```

Windows Firewall mein sirf **TCP 1935 (RTMP)** private network ke liye allow
karein. Web, admin, WHIP aur ICE loopback (127.0.0.1) par hi rehte hain — LAN se
sirf OBS RTMP aata hai. Studio mein dikhaya gaya server/key OBS mein daalein;
OBS ke **Settings → Advanced → Automatically Reconnect** on rakhein.

## 5. Stage layout

- **Screen left:** Rashi ka Studio (camera live).
- **Screen right:** Lakshita ka Watch page — _Stream health overlay: on_ aur chat.
- **Doosra monitor / projector:** `/control/presentation` (Rashi profile, naye tab mein).
- **Chhota terminal:** `npm.cmd run final:watch` (aur chahein to `npm.cmd run final:healer-log`).
- Chahein to Docker Desktop ki container list bhi dikhayein — container
  **Exited (137)** hota hai aur bina kisi ke Start dabaye **Running** wapas aata
  hai, uptime zero se shuru.

Camera nahi hai? `npm.cmd run final:demo` 10-minute ka test pattern stream
chalata hai aur presentation URL print karta hai.

## 6. 5-minute script

| Time | Kya karein                                                                                                | Kya bolein                                                                                                                                                            |
| ---- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00 | Teeno screens dikhayein, overall pill green                                                               | "Yeh asli live video hai. Har dabba asli state se rang leta hai."                                                                                                     |
| 0:40 | **Disconnect Redis** (target `redis` type karein)                                                         | "Redis memory khatam ho jaye ya host restart ho jaye — yahi end state."                                                                                               |
| 0:50 | Lakshita chat mein likhe → Rashi tak nahi pahunchta; chat label _Chat reconnecting…_; video chal raha hai | "Chat toot gaya, video nahi — media aur chat alag raste hain."                                                                                                        |
| 1:10 | Redis node red → blue (Healer starting) → green; `final:watch` mein naya StartedAt                        | "Healer ne khud diagnose kiya — 'Redis is gone' — aur start kiya. Kisi ne Start nahi dabaya."                                                                         |
| 1:30 | Lakshita ka naya message Rashi ko dikhta hai                                                              | "Verified: PING + dono API ready. History safe hai."                                                                                                                  |
| 1:50 | **Crash video gateway**                                                                                   | "Connection exhaustion ya kharab config reload."                                                                                                                      |
| 2:00 | Lakshita ke overlay mein _Frozen for 5 s…_                                                                | "Har viewer ka video ruk gaya — backup nahi hai."                                                                                                                     |
| 2:20 | Video khud chalu, _Resumed after N s_                                                                     | "Healer ne gateway start kiya aur gateway ke through naye segments verify kiye."                                                                                      |
| 2:40 | **Freeze API-2**                                                                                          | "Deadlock ya infinite loop — process zinda hai par jawab nahi deta."                                                                                                  |
| 3:00 | Footer latency ~10 s tak jaati hai                                                                        | "Hang crash se bura hai: har request timeout tak wait karti hai."                                                                                                     |
| 3:30 | API-2 node _Healer restarting_; diagnosis 'alive but unresponsive'                                        | "Healer 10 s wait karta hai, khud probe karta hai, healthy API-1 ko bhi probe karta hai (woh fast hai, toh yeh hang hai, bheed nahi) — phir **restart**, start nahi." |
| 4:10 | `/control/analysis` — swimlanes green → red → blue → green                                                | "Yeh poori kahani database ke asli timestamps se hai."                                                                                                                |
| 4:40 | Recovery report                                                                                           | "Detect, act, verify — har number stored timestamps ka farq hai."                                                                                                     |

## 7. 10-minute script

5-minute script ke baad yeh jodiye:

1. **Crash the whole API tier** (target `api-tier`): Lakshita ki site par lal
   banner _StreamShield can't reach the server — retrying in 3s_; video phir bhi
   chal raha hai. Healer pehle API-1, phir API-2 start karta hai (ek waqt mein ek
   operation). Banner khud gayab, data khud reload, footer _Served by API-1 / API-2_.
2. **Crash ingest relay** (target `relay`): Studio _Connection to server lost ·
   reconnecting_, Lakshita _Broadcaster reconnecting…_. Healer relay start karta
   hai; Studio khud republish karta hai. Saaf boliye: "Server Healer ne theek kiya;
   broadcaster ka client khud reconnect hua — report mein yeh alag likha hai."
3. **Traffic surge** (target `api-tier`): load meter upar, p95 1.2 s se upar,
   Healer spare **API-3** start karta hai (topology mein API-3 jalta hai, footer
   par _Served by API-3_). Load khatam hone ke baad 60 s normal rehne par Healer
   API-3 ko wapas band karta hai (scale-in). Imaandari se boliye: "Is laptop par
   spare se ~33% zyada throughput mila; latency load khatam hone ke baad hi
   threshold se neeche aayi — yeh capacity claim nahi, demo evidence hai."
4. **Crash Edge-1:** video nahi rukta, overlay _Served by Edge-2_, baad mein Edge-1 wapas.
5. Resilience section (network latency / external API) — "yeh timed cleanup hai, Healer repair nahi."
6. Disabled buttons dikhayein aur kaaran padhein (database, broadcaster).
7. **Professor's choice:** Docker Desktop mein koi allowlisted container (e.g. edge-2)
   Stop karwayein — Healer usse bhi detect karke start karega.

## 8. Pre-demo checklist

- [ ] Docker Desktop: 4 CPU / 8 GB; `npm.cmd run final:status` mein sab healthy, api-3 `Created`.
- [ ] `npm.cmd run chaos:probe` → `available: true`.
- [ ] Rashi admin hai; dono Chrome profiles logged in.
- [ ] Ek asli live stream (Studio camera ya `final:demo`) — Lakshita ko video dikh raha hai.
- [ ] `/control/presentation` par buttons enabled (agar "budget … until HH:MM" likha hai to wait karein).
- [ ] Rehearsal ke baad kam se kam **10 minute** ka gap — har service ka budget 10 min mein 2 operations.
- [ ] `final:watch` terminal khula.

## 9. Agar live demo mein kuch galat ho jaye

| Problem                                              | Kya karein                                                                                                                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Button disabled: "budget/cooldown … until 12:34 UTC" | Yeh safety hai — doosra scenario chalayein ya wait karein. Isse bataiye: "Chaos kabhi aisa fault inject nahi karta jo Healer theek na kar sake."                                                             |
| Experiment FAILED / ESCALATED (purple)               | Report kholiye, reason padhiye. Yeh bhi demo ka hissa hai — Healer safely ruk gaya. Operator fix: `npm.cmd run final:status`, phir zaroorat ho to `node infrastructure/dynamic/compose.mjs start <service>`. |
| Video nahi chal raha                                 | `final:demo` chalayein, Watch page refresh. Studio camera permission check karein.                                                                                                                           |
| Stream "ended" ho gayi relay crash ke baad           | Broadcaster 8 s ke andar reconnect nahi hua (`DYNAMIC_SOURCE_GRACE_MS`). Naya livestream banayein.                                                                                                           |
| Sab kuch lal / stale                                 | `npm.cmd run final:status`; observer/healer restart: `node infrastructure/dynamic/compose.mjs restart observer healer`.                                                                                      |
| Kuch bhi kaam nahi                                   | Pehle se record kiye screenshots `docs/screenshots/final/` aur report dikhayein.                                                                                                                             |
