#!/usr/bin/env python3
"""Build the five-page submission PDF and readable companion from committed evidence.

Requires reportlab only: python -m pip install reportlab
Run from any directory: python scripts/build-resilience-report.py
"""
from html import escape
import json
from pathlib import Path

from reportlab.graphics.shapes import Drawing, Line, Polygon, Rect, String
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    Flowable, KeepTogether, PageBreak, Paragraph, SimpleDocTemplate, Spacer,
    Table, TableStyle,
)

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
DATA = json.loads((DOCS / "RESILIENCE_REPORT_DATA.json").read_text(encoding="utf-8"))
PDF = DOCS / "StreamShield_Resilience_Report.pdf"
MD = DOCS / "RESILIENCE_REPORT.md"
INK = colors.HexColor("#142234")
MUTED = colors.HexColor("#526276")
RED = colors.HexColor("#ce284b")
TEAL = colors.HexColor("#087c73")
PALE = colors.HexColor("#f1f5f9")
RULE = colors.HexColor("#d8e1eb")
WIDTH = A4[0] - 84


def fonts():
    candidates = [
        (Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
         Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")),
        (Path("C:/Windows/Fonts/arial.ttf"), Path("C:/Windows/Fonts/arialbd.ttf")),
    ]
    for regular, bold in candidates:
        if regular.exists() and bold.exists():
            pdfmetrics.registerFont(TTFont("Report", str(regular)))
            pdfmetrics.registerFont(TTFont("ReportBold", str(bold)))
            pdfmetrics.registerFontFamily("Report", normal="Report", bold="ReportBold")
            return "Report", "ReportBold"
    return "Helvetica", "Helvetica-Bold"


FONT, BOLD = fonts()
STYLE = getSampleStyleSheet()
STYLE.add(ParagraphStyle("BodyReport", fontName=FONT, fontSize=9.1, leading=13.1,
                         textColor=INK, spaceAfter=7))
STYLE.add(ParagraphStyle("SmallReport", parent=STYLE["BodyReport"], fontSize=7.9,
                         leading=11.2, textColor=MUTED, spaceAfter=5))
STYLE.add(ParagraphStyle("TitleReport", fontName=BOLD, fontSize=25, leading=29,
                         textColor=INK, spaceAfter=9))
STYLE.add(ParagraphStyle("ChapterReport", fontName=BOLD, fontSize=18, leading=22,
                         textColor=INK, spaceAfter=10))
STYLE.add(ParagraphStyle("SectionReport", fontName=BOLD, fontSize=11.5, leading=15,
                         textColor=INK, spaceBefore=9, spaceAfter=6))
STYLE.add(ParagraphStyle("KickerReport", fontName=BOLD, fontSize=8, leading=11,
                         textColor=RED, spaceAfter=6))
STYLE.add(ParagraphStyle("TableReport", fontName=FONT, fontSize=8.0, leading=10.7,
                         textColor=INK))
STYLE.add(ParagraphStyle("TableHeadReport", parent=STYLE["TableReport"], fontName=BOLD,
                         textColor=colors.white))
STYLE.add(ParagraphStyle("MetricReport", parent=STYLE["BodyReport"], fontName=BOLD,
                         fontSize=11.5, leading=15, alignment=TA_CENTER,
                         textColor=TEAL, spaceAfter=0))
STYLE.add(ParagraphStyle("CodeReport", fontName="Courier", fontSize=8.3,
                         leading=12, backColor=PALE, borderPadding=10,
                         textColor=INK, spaceBefore=4, spaceAfter=11))


def p(text, style="BodyReport"):
    return Paragraph(text, STYLE[style])


def table(headers, rows, widths):
    contents = [[p(escape(str(h)), "TableHeadReport") for h in headers]]
    contents += [[p(str(value), "TableReport") for value in row] for row in rows]
    t = Table(contents, colWidths=widths, repeatRows=1, hAlign="LEFT")
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), INK),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, PALE]),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("LINEBELOW", (0, 0), (-1, 0), 0.5, INK),
        ("LINEBELOW", (0, 1), (-1, -1), 0.35, RULE),
    ]))
    return t


def seconds(value):
    return "Not recorded" if value is None else f"{value / 1000:.3f} s"


def line_arrow(d, x1, y1, x2, y2, color, dashed=False, both=False):
    import math
    line = Line(x1, y1, x2, y2, strokeColor=color, strokeWidth=1.25)
    if dashed:
        line.strokeDashArray = [4, 3]
    d.add(line)
    def head(x, y, angle):
        length, breadth = 5.3, 2.6
        ux, uy = math.cos(angle), math.sin(angle)
        d.add(Polygon([x, y, x-length*ux+breadth*uy, y-length*uy-breadth*ux,
                       x-length*ux-breadth*uy, y-length*uy+breadth*ux],
                      fillColor=color, strokeColor=color))
    angle = math.atan2(y2-y1, x2-x1)
    head(x2, y2, angle)
    if both:
        head(x1, y1, angle+math.pi)


def architecture():
    d = Drawing(WIDTH, 275)
    def box(x, y, w, title, sub, fill=PALE, h=37):
        d.add(Rect(x, y, w, h, rx=5, ry=5, fillColor=fill,
                   strokeColor=RULE, strokeWidth=0.8))
        d.add(String(x+w/2, y+h-14, title, textAnchor="middle", fontName=BOLD,
                     fontSize=8.2, fillColor=INK))
        d.add(String(x+w/2, y+9, sub, textAnchor="middle", fontName=FONT,
                     fontSize=6.8, fillColor=MUTED))
    box(8, 228, 90, "Camera / OBS", "Browser or RTMP source")
    box(127, 228, 90, "Ingest relay", "MediaMTX")
    box(247, 228, 105, "Primary + standby", "RTSP pull / HLS origins")
    box(380, 228, 123, "Edge-1 + Edge-2", "Nginx segment caches")
    box(380, 163, 123, "Video gateway", "Singleton HLS entry")
    box(247, 163, 105, "Web proxy", "Static UI + route proxy")
    box(127, 163, 90, "Watch / Studio", "Decoded video + chat")
    box(247, 103, 105, "API gateway", "REST / Socket.IO")
    box(380, 103, 123, "API-1 + API-2", "Application services")
    box(380, 43, 58, "Postgres", "Durable data")
    box(445, 43, 58, "Redis", "Chat / leases")
    line_arrow(d, 98, 246, 127, 246, TEAL)
    line_arrow(d, 217, 246, 247, 246, TEAL)
    line_arrow(d, 352, 246, 380, 246, TEAL)
    line_arrow(d, 441, 228, 441, 200, TEAL)
    line_arrow(d, 380, 181, 352, 181, TEAL)
    line_arrow(d, 247, 181, 217, 181, TEAL, both=True)
    line_arrow(d, 299, 163, 299, 140, colors.HexColor("#3568a4"), both=True)
    line_arrow(d, 352, 121, 380, 121, colors.HexColor("#3568a4"), both=True)
    line_arrow(d, 418, 103, 409, 80, colors.HexColor("#3568a4"))
    line_arrow(d, 462, 103, 474, 80, colors.HexColor("#3568a4"))
    d.add(Rect(8, 43, 221, 97, rx=6, ry=6, fillColor=colors.HexColor("#f7edf1"),
               strokeColor=colors.HexColor("#e9bdc9")))
    for y, text, bold in [
        (122, "INDEPENDENT CONTROL", True),
        (104, "Observer: fresh probes + incidents", False),
        (88, "Healer: bounded action + verification", False),
        (72, "Chaos: administrator-approved faults", False),
        (56, "Private adapters: scoped Docker authority", False),
    ]:
        d.add(String(18, y, text, fontName=BOLD if bold else FONT,
                     fontSize=7.6, fillColor=RED if bold else INK))
    line_arrow(d, 229, 60, 380, 103, RED, dashed=True)
    d.add(String(8, 20, "Green: media   Blue: application   Dashed red: probes / scoped actions",
                 fontName=FONT, fontSize=7.2, fillColor=MUTED))
    d.add(String(8, 7, "Logical flow; API-2 and control roles share one fixture container. One host.",
                 fontName=FONT, fontSize=7.2, fillColor=MUTED))
    return d


NAMES = {"crash-api": "API server crash", "crash-video-gateway": "Video gateway crash",
         "crash-edge": "Edge node failure", "network-timeout": "Network disruption"}
DETECT = {
    "crash-api": "Independent readiness probe becomes unreachable; consecutive failures confirm the incident.",
    "crash-video-gateway": "Gateway health is unreachable; real HLS delivery through it fails.",
    "crash-edge": "Edge-1 probe fails; actual delivery is observed through Edge-2.",
    "network-timeout": "Safe recommendation reads time out; the dependency circuit opens and the observer confirms failure.",
}
HEAL = {
    "crash-api": "API-2 serves requests. Healer starts API-1; readiness, catalog and gateway participation verify recovery.",
    "crash-video-gateway": "Healer starts the gateway; valid playlists/init/media and advancing segments through it verify recovery.",
    "crash-edge": "Edge-2 carries delivery. Healer starts Edge-1 and independently verifies live media; peer remains unchanged.",
    "network-timeout": "Owned 20-second delay expires/is removed. Circuit half-open reads verify reconnection; this is not a third-party repair.",
}
ROWS = DATA["scenarios"]
BY_ID = {s["scenario"]: s for s in ROWS}
REPO = DATA["repository"]


def header_footer(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(RED)
    canvas.rect(42, A4[1]-27, WIDTH, 3, fill=1, stroke=0)
    canvas.setFont(FONT, 7.4)
    canvas.setFillColor(MUTED)
    canvas.drawString(42, 24, "StreamShield | Resilience report | 27 October 2026")
    canvas.drawRightString(A4[0]-42, 24, f"{doc.page} / 5")
    canvas.restoreState()


def section(title):
    return p(title, "SectionReport")


def chapter(number, title):
    return [p(f"RESILIENCE / {number:02d}", "KickerReport"), p(title, "ChapterReport")]


def generate_pdf():
    story = [p("ENGINEERING REPORT / RECORDED EXPERIMENTS", "KickerReport"),
             p("StreamShield<br/>Resilience report", "TitleReport"),
             p("Real streaming, controlled failures and independently verified restoration.")]
    metrics = [[p("4 / 4<br/>faults verified", "MetricReport"),
                p("13<br/>containers cleaned", "MetricReport"),
                p(f"{DATA['checks']['unitTests']}<br/>unit checks passed", "MetricReport")]]
    band = Table(metrics, colWidths=[WIDTH/3]*3)
    band.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), PALE),
                              ("TOPPADDING", (0, 0), (-1, -1), 9),
                              ("BOTTOMPADDING", (0, 0), (-1, -1), 9)]))
    story += [band, section("Architecture and responsibility boundaries"), architecture()]
    story += [p("Creators publish via WHIP/WebRTC or RTMP. MediaMTX relays and remuxes to primary/standby origins; Nginx edges and the video gateway deliver HLS. Express serves accounts, metadata and Socket.IO chat, while PostgreSQL stores durable records and Redis distributes ephemeral state.")]
    env = DATA["environment"]["docker"]
    gib = env["memoryBytes"]/1024**3
    story += [section("Scope and test environment"),
              p(f"Run <b>{DATA['run']['id']}</b> on 27 October 2026: Linux Docker {env['serverVersion']}, {env['cpus']} reported CPUs, {gib:.1f} GiB reported memory, {env['storageDriver']} storage, Chromium and one generated H.264/AAC live path. These are daemon-reported resources, not a peak-usage measurement. The compact fixture omits Prometheus, Grafana and API-3."),
              p("Persistent application: <b>127.0.0.1:5173</b>. Disposable streaming/chaos demo: <b>127.0.0.1:5174</b>. They use separate projects and data; demo faults exclude the persistent application. Physical Windows/8 GB laptop performance is not established by this Linux run.", "SmallReport")]

    story += [PageBreak(), *chapter(2, "Failure detection and healing")]
    story += [p("Each crash uses actual SIGKILL in a newly owned fixture. Network disruption uses real Toxiproxy latency on a simulated read-only recommendation path. The manual scenario is separate historical acceptance evidence.")]
    failure_rows = []
    for s in ROWS:
        key = s["scenario"]
        failure_rows.append([
            f"<b>{NAMES[key]}</b>",
            escape(DETECT[key])+f"<br/><b>Detect: {seconds(s['detectionMs'])}</b>",
            escape(HEAL[key]),
            f"<b>{seconds(s['recoveryMs'])}</b><br/>Verified",
        ])
    failure_rows.append(["<b>Media authorization loss</b>",
                         "Both video routes deny new HLS; buffered playback drains and stops.",
                         "Operator restores simulated signing authority; advancing video must then be verified. No real key is destroyed or recreated.",
                         "<b>Not recorded</b><br/>Human action required"])
    story += [table(["Failure", "How detected", "How restored / verified", "Recovery time"],
                    failure_rows, [88, 132, 203, WIDTH-423]), Spacer(1, 10)]
    story += [section("What the recovery number means"),
              p("Recovery time = <b>independent service verification timestamp - fault injection timestamp</b>. It includes detection, action and verification. Docker action duration and total demonstration duration are separate. A 15-second observation target is not a guaranteed recovery deadline."),
              p("For API and edge failures, redundancy may preserve video. For gateway failure, a buffered player may continue briefly before stalling. Network-fault time includes the injected delay's expiry and successful circuit reads. The fifth scenario's duration was not stored; no estimate is substituted.", "SmallReport"),
              section("Current result"),
              p("All four automated experiments returned their affected cards to Healthy with retained recovery timestamps, real playback progress and verified service behavior. The three crash cases recorded <b>docker_start_accepted</b>; the network case recorded safe-read/circuit reconnection evidence. The control-plane container remained running.")]

    story += [PageBreak(), *chapter(3, "Before-and-after numbers")]
    network = BY_ID["network-timeout"]
    story += [p("The first table tracks service state across the same experiment. The running flags are binary process observations, not throughput or audience-capacity measurements.")]
    story += [table(["Signal", "Before fault", "During fault", "After verification"], [
        ["API-1 running flag", "1", "0; exit 137", "1; functional checks pass"],
        ["Video gateway running flag", "1", "0; exit 137", "1; HLS progresses"],
        ["Edge-1 running flag", "1", "0; Edge-2 serves", "1; peer unchanged"],
        ["Recommendation read", f"{network['networkBaselineMs']} ms", "Timeout / circuit opens", f"{network['networkVerifiedMs']} ms; circuit closed"],
    ], [134, 91, 127, WIDTH-352])]
    story += [section("Actual decoded playback after each restoration")]
    playback_rows = []
    for s in ROWS:
        b = s["browserPlayback"]
        frames = b["after"]["frames"]-b["before"]["frames"]
        delta = b["after"]["currentTime"]-b["before"]["currentTime"]
        playback_rows.append([NAMES[s["scenario"]],
                              f"{b['before']['frames']} to {b['after']['frames']} (+{frames})",
                              f"+{delta:.3f} s", str(b["newMediaResponses"])])
    story += [table(["Restored scenario", "Decoded frames", "Media-time advance", "New media responses"],
                    playback_rows, [134, 145, 119, WIDTH-398]),
              p("These are short post-restoration samples of a 640 x 360 player. They prove resumed/continuing playback, not total outage or buffering duration. Playback interruption was unmeasured (null) in this run; null does not mean zero.", "SmallReport")]
    story += [section("Comparison with the earlier recorded local run")]
    compare = []
    for s in ROWS:
        delta = (s["recoveryMs"]-s["earlierRecoveryMs"])/1000
        compare.append([NAMES[s["scenario"]], seconds(s["earlierRecoveryMs"]),
                        seconds(s["recoveryMs"]), f"{delta:+.3f} s"])
    story += [table(["Scenario", "Earlier 282d20da", "Current a484d151", "Change"],
                    compare, [154, 128, 128, WIDTH-410]),
              p("Earlier: 26 October; current: 27 October. This is a descriptive cross-run comparison, not a controlled benchmark: host load and code differ. Both slower and faster results are retained. No causal speedup, percentile or reliability improvement is inferred from two local runs.", "SmallReport")]

    story += [PageBreak(), *chapter(4, "Control policy and reproducibility")]
    story += [section("Recovery is an evidence-driven state machine"),
              p("Fresh failures are confirmed by the Observer. The Healer selects a component/symptom playbook, checks dependencies and authority, persists intent, requests an allowed action, and independently verifies stable behavior. SCHEDULED → EXECUTING → VERIFYING → VERIFIED; unsupported, ambiguous or exhausted work escalates."),
              table(["Guard", "Enforced behavior"], [
                  ["Identity and authority", "Administrator + CSRF/origin checks + typed target; adapter identifies the exact owned Compose project and service."],
                  ["Durable actions", "Local SQLite intent/lease epochs and PostgreSQL audit records; ambiguous actions are not blindly replayed."],
                  ["Bounded repair", "Default 2 operations/service/10 minutes; 30-second cooldown. Never restart the last serving API or mutate PostgreSQL automatically."],
                  ["Fresh functional proof", "Readiness/catalog/gateway participation for API; real initialization/segment bytes and progression for media. Stale or missing evidence stays unknown."],
              ], [125, WIDTH-125]),
              section("Run the submitted chaos script"),
              p("Use Node.js 24, Docker with Linux containers and Playwright Chromium. Prepare the pinned images and configuration using README.md first. Use one fixture at a time."),
              p("npm ci<br/>npm run setup:platform<br/>npm run build<br/>npx playwright install chromium<br/><br/>npm run chaos -- --help<br/>npm run chaos -- --verify<br/>npm run chaos -- --interactive", "CodeReport"),
              p("The new entry point delegates to the existing isolated driver in the same Node process, preserving Windows Ctrl+C cleanup. It accepts only the documented modes; arbitrary target/host arguments are rejected before Docker is touched. Interactive controls expose the fifth, operator-only case."),
              section("Evidence and cleanup"),
              p(f"Fresh automated run: <b>4/4</b> verified scenarios; <b>13</b> own containers removed; local user environment unchanged. Unit/security suite: <b>{DATA['checks']['unitTests']}</b> checks across <b>{DATA['checks']['testFiles']}</b> files, plus typecheck and lint. The real fixture compiled current services/static assets and decoded video."),
              p("Detailed results: test-results/light-four/runs/a484d151/measurements.json. A safe selected snapshot is committed as docs/RESILIENCE_REPORT_DATA.json. Request IDs, timestamps and receipts correlate evidence; private keys and passwords are not report data.", "SmallReport")]

    story += [PageBreak(), *chapter(5, "Known limits and evidence register")]
    limits = [
        ("One host and singleton services", "All redundant peers share one Docker host. Host loss is not healed. Database, relay, gateways, Redis and web remain singleton boundaries."),
        ("Compact privilege boundary", "API-2 and trusted control processes share a container. The restricted API peer is denied Docker access, but privileged adapters still require host trust; this is not multi-tenant production isolation."),
        ("Source and external authority", "Only the broadcaster can restore missing camera/capture/internet input. Lost private keys or external signing permissions require authorized human restoration. The fifth failure simulates that limit; it does not integrate a real key vault."),
        ("Timed cleanup is not infrastructure repair", "Toxiproxy affects a private simulated dependency. The network fault expires and circuit reads reconnect; no claim is made about repairing an ISP or external provider."),
        ("Measurements are bounded observations", "One generated source and one cloud-host run do not establish production capacity or tail latency. The 50,000-viewer target remains unverified; no zero-interruption claim is made."),
        ("Windows and resource limits", "Physical devices, VPN/firewall behavior and an 8 GB Windows laptop are not certified here. Local startup delays were observed on that PC. The larger Linux host's results are not transferable performance guarantees."),
        ("Public deployment work", "Local HTTP/RTMP and loopback ICE need a deliberate TLS, STUN/TURN/NAT, secrets, off-host backup, independent failure-domain and delivery-capacity design before public deployment."),
    ]
    for title, body in limits:
        story += [p(f"<b>{title}.</b> {body}")]
    story += [section("Evidence register / repository navigation")]
    refs = [
        ("[1] Current run and selected raw numbers", "docs/RESILIENCE_REPORT_DATA.json"),
        ("[2] Earlier four-fault evidence: 282d20da", "docs/RECOVERY_HEALTH_VALIDATION.json"),
        ("[3] Separate manual authority-loss acceptance", "docs/SYSTEM_LOGS_VALIDATION.json"),
        ("[4] Browser-startup / real recovery regression", "docs/BROWSER_READINESS_VALIDATION.json"),
        ("[5] README and reproducible setup", "README.md"),
        ("[6] Submitted chaos entry point", "scripts/chaos.mjs"),
        ("[7] Actual experiment driver", "scripts/four-scenario-live.mjs"),
    ]
    for label, path in refs:
        url = REPO+"/blob/main/"+path
        story += [p(f'<link href="{url}" color="#175a91">{escape(label)} — {escape(path)}</link>', "SmallReport")]
    story += [Spacer(1, 4), p("Application baseline: main commit <b>48cf25b</b> (same application tree as a783fdb), plus the submitted chaos entry point and report. This report records local verification; it does not assert that remote GitHub Actions jobs or physical Windows checks passed.", "SmallReport")]
    doc = SimpleDocTemplate(str(PDF), pagesize=A4, rightMargin=42, leftMargin=42,
                            topMargin=43, bottomMargin=43, title=DATA["title"],
                            author="StreamShield project", subject="Measured chaos and resilience evaluation")
    doc.build(story, onFirstPage=header_footer, onLaterPages=header_footer)
    if doc.page != 5:
        raise RuntimeError(f"Expected five report pages, produced {doc.page}; adjust layout.")


def generate_markdown():
    lines = ["# StreamShield resilience report", "", "**Date:** 27 October 2026. **Format:** five-page PDF submission.",
             "", "[Download/read the PDF](StreamShield_Resilience_Report.pdf) · [Report data](RESILIENCE_REPORT_DATA.json) · [README](../README.md)",
             "", "## 1. Architecture and scope", "",
             "Camera/OBS → MediaMTX relay → primary/standby origins → Nginx edges → video gateway → web proxy → HLS viewer. REST and Socket.IO use web → API gateway → API-1/API-2 → PostgreSQL/Redis. The independent Observer detects; the Healer repairs through an allowlisted adapter; Chaos requests owned faults and checks independent evidence. API-2/control roles share one fixture container, and all services share one host.",
             "", f"Fresh run `{DATA['run']['id']}`: Linux Docker/Chromium, one generated H.264/AAC path, {DATA['environment']['docker']['cpus']} reported CPUs and {DATA['environment']['docker']['memoryBytes']/1024**3:.1f} GiB daemon-reported memory. Physical Windows/8 GB laptop performance is not established.",
             "", "## 2. Failure table", "", "| Failure | Detection | Healing / verification | Measured recovery |", "| --- | --- | --- | --- |"]
    for s in ROWS:
        key=s["scenario"]
        lines.append(f"| {NAMES[key]} | {DETECT[key]} Detection {seconds(s['detectionMs'])}. | {HEAL[key]} | {seconds(s['recoveryMs'])} |")
    lines += ["| Media authorization loss | Both HLS routes deny new requests; buffered playback drains. | Explicit operator reset and advancing-media verification; separate historical acceptance. | Not recorded; human intervention required |", "",
              "Recovery is injection-to-independent-service-verification, not Docker-action duration or browser buffering time. Network recovery includes owned 20-second fault expiry and circuit reconnection. No duration was recorded for the manual case; no estimate is substituted.",
              "", "## 3. Before-and-after numbers", "", "| Signal | Before fault | During fault | After verification |", "| --- | --- | --- | --- |",
              "| API-1 running flag | 1 | 0; exit 137 | 1; functional checks pass |",
              "| Video gateway running flag | 1 | 0; exit 137 | 1; HLS progresses |",
              "| Edge-1 running flag | 1 | 0; Edge-2 serves | 1; peer unchanged |",
              f"| Recommendation read | {BY_ID['network-timeout']['networkBaselineMs']} ms | Timeout / circuit opens | {BY_ID['network-timeout']['networkVerifiedMs']} ms; circuit closed |", "",
              "Running flags are state observations, not throughput measurements.", "",
              "| Post-repair player sample | Decoded frames before → after | Media-time advance | New media responses |", "| --- | --- | --- | --- |"]
    for s in ROWS:
        b=s["browserPlayback"]
        lines.append(f"| {NAMES[s['scenario']]} | {b['before']['frames']} → {b['after']['frames']} | +{b['after']['currentTime']-b['before']['currentTime']:.3f} s | {b['newMediaResponses']} |")
    lines += ["", "Playback samples establish progress after recovery. Total playback interruption was unmeasured (`null`), not zero.", "",
              "| Scenario | Earlier 282d20da | Current a484d151 | Change |", "| --- | --- | --- | --- |"]
    for s in ROWS:
        lines.append(f"| {NAMES[s['scenario']]} | {seconds(s['earlierRecoveryMs'])} | {seconds(s['recoveryMs'])} | {(s['recoveryMs']-s['earlierRecoveryMs'])/1000:+.3f} s |")
    lines += ["", "This two-run comparison is descriptive, not controlled: host load and code differ. Both slower and faster values are retained; no causal speedup or statistical reliability improvement is inferred.",
              "", "## 4. Policy, execution and validation", "",
              "Fresh confirmed evidence → symptom-specific playbook → lease/budget/dependency checks → durable action intent → restricted Docker receipt → independent stable functional verification. Unknown, escalated, stale or ambiguous evidence never establishes success. Default policy limits operations to two per service per ten minutes with a 30-second cooldown. Database repair and broadcaster recreation are outside automatic authority.",
              "", "Prepare images/configuration using the README; use one disposable fixture at a time:", "", "```powershell", "npm.cmd run chaos -- --help", "npm.cmd run chaos -- --verify", "npm.cmd run chaos -- --interactive", "```", "",
              f"The fresh script run passed 4/4 cases, removed 13 owned containers and preserved the user's environment. {DATA['checks']['unitTests']} unit/security checks across {DATA['checks']['testFiles']} files passed, with typecheck and lint. Actual fixture compilation and browser decoding passed. Arbitrary targets are rejected before Docker use. Manual authorization loss is available interactively and verified separately.",
              "", "## 5. Known limits and sources", "",
              "- One host; singleton database, relay, gateways, Redis and web remain failure boundaries.",
              "- Compact control roles/API-2 share a trusted container; privileged Docker adapters require host trust.",
              "- No automatic recreation of camera input, lost signing material or missing external permissions.",
              "- Toxiproxy models a private dependency; timed cleanup is not an ISP/provider repair.",
              "- No verified 50,000-viewer capacity, production availability, tail-latency or zero-interruption guarantee.",
              "- Physical Windows devices/networking and 8 GB laptop performance are unverified; cloud figures are not transferable guarantees.",
              "- Public deployment needs TLS, NAT/TURN design, secrets, backups and independent failure domains.", "",
              "Sources: [current report data](RESILIENCE_REPORT_DATA.json), [earlier four-fault data](RECOVERY_HEALTH_VALIDATION.json), [manual failure evidence](SYSTEM_LOGS_VALIDATION.json), [browser recovery regression](BROWSER_READINESS_VALIDATION.json), [chaos entry point](../scripts/chaos.mjs), [actual driver](../scripts/four-scenario-live.mjs).", "",
              "Application baseline: `48cf25b` (same application tree as `a783fdb`), plus the submitted entry point/report. Local checks do not assert remote CI or physical Windows acceptance.", ""]
    MD.write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    if DATA["run"]["status"] != "PASS" or len(ROWS) != 4:
        raise SystemExit("The report requires four verified recorded experiments.")
    generate_markdown()
    generate_pdf()
    print(f"Created {PDF.relative_to(ROOT)} (5 pages) and {MD.relative_to(ROOT)}")
