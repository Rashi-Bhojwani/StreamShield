#!/usr/bin/env python3
"""Build StreamShield's single-page, vector A3 landscape architecture sheet.

Requires ReportLab: python -m pip install reportlab
Run: python scripts/build-architecture-pdf.py
"""
from html import escape
import json
import math
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A3, landscape
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "StreamShield_System_Architecture.pdf"
DATA = json.loads((ROOT / "docs/RESILIENCE_REPORT_DATA.json").read_text())
REPO = "https://github.com/Rashi-Bhojwani/StreamShield"
W, H = landscape(A3)
INK = colors.HexColor("#13243A")
MUTED = colors.HexColor("#53677D")
LINE = colors.HexColor("#D8E3EC")
PALE = colors.HexColor("#F4F7FA")
TEAL = colors.HexColor("#087D78")
BLUE = colors.HexColor("#275BB0")
RED = colors.HexColor("#C62D50")


def font_pair():
    for regular, bold in [
        ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
         "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
        ("C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/arialbd.ttf"),
    ]:
        if Path(regular).exists() and Path(bold).exists():
            pdfmetrics.registerFont(TTFont("Architecture", regular))
            pdfmetrics.registerFont(TTFont("ArchitectureBold", bold))
            pdfmetrics.registerFontFamily("Architecture", normal="Architecture",
                                         bold="ArchitectureBold")
            return "Architecture", "ArchitectureBold"
    return "Helvetica", "Helvetica-Bold"


FONT, BOLD = font_pair()
C = canvas.Canvas(str(OUT), pagesize=(W, H), pageCompression=1, invariant=1)
C.setTitle("System Architecture of StreamShield | One-page architecture")
C.setAuthor("StreamShield project")
C.setSubject("Application, media, data, reliability, authority and failure boundaries")


def txt(x, top, text, size=9, bold=False, color=INK, align="left"):
    C.setFont(BOLD if bold else FONT, size)
    C.setFillColor(color)
    method = {"left": C.drawString, "center": C.drawCentredString,
              "right": C.drawRightString}[align]
    method(x, H-top-size, text)


def para(x, top, width, text, size=9, leading=12.5, color=INK,
         limit=None, center=False):
    style = ParagraphStyle("block", fontName=FONT, fontSize=size, leading=leading,
                           textColor=color, alignment=TA_CENTER if center else 0)
    p = Paragraph(text, style)
    _, height = p.wrap(width, H)
    if limit is not None and height > limit + 0.1:
        raise ValueError(f"Architecture text overflows ({height}>{limit}): {text}")
    if top + height > H - 20:
        raise ValueError("Architecture content exceeds page boundary")
    p.drawOn(C, x, H-top-height)
    return height


def rect(x, top, width, height, fill=colors.white, stroke=LINE, radius=8):
    C.setFillColor(fill)
    C.setStrokeColor(stroke)
    C.setLineWidth(0.7)
    C.roundRect(x, H-top-height, width, height, radius, fill=1, stroke=1)


def arrow(points, color, both=False, dashed=False, width=1.5):
    C.saveState()
    C.setStrokeColor(color)
    C.setFillColor(color)
    C.setLineWidth(width)
    if dashed:
        C.setDash(4, 3)
    path = C.beginPath()
    path.moveTo(points[0][0], H-points[0][1])
    for x, y in points[1:]:
        path.lineTo(x, H-y)
    C.drawPath(path)
    C.setDash()
    def head(a, b):
        angle = math.atan2(b[1]-a[1], b[0]-a[0])
        ux, uy = math.cos(angle), math.sin(angle)
        tip = C.beginPath()
        tip.moveTo(b[0], H-b[1])
        tip.lineTo(b[0]-5*ux+2.5*uy, H-(b[1]-5*uy-2.5*ux))
        tip.lineTo(b[0]-5*ux-2.5*uy, H-(b[1]-5*uy+2.5*ux))
        tip.close()
        C.drawPath(tip, fill=1, stroke=0)
    head(points[-2], points[-1])
    if both:
        head(points[1], points[0])
    C.restoreState()


def node(x, top, width, height, title, body, accent):
    rect(x, top, width, height)
    C.setFillColor(accent)
    C.roundRect(x, H-top-height, 3, height, 1.5, fill=1, stroke=0)
    para(x+9, top+9, width-18, f"<b>{escape(title)}</b>", size=9.5,
         leading=12, limit=24, center=True)
    para(x+8, top+27, width-16, body, size=8.2, leading=10.8,
         color=MUTED, limit=height-29, center=True)


def panel(x, top, width, height, number, title, accent):
    rect(x, top, width, height, fill=PALE)
    txt(x+14, top+13, number, size=10, bold=True, color=accent)
    txt(x+39, top+12, title, size=11, bold=True)


def pill(x, top, width, title, body, accent):
    rect(x, top, width, 47)
    txt(x+12, top+7, title, size=8.2, bold=True, color=accent)
    txt(x+12, top+23, body, size=9.3)


def build():
    # Header: deliberately one sheet, suitable for zooming or A3 printing.
    C.setFillColor(INK)
    C.rect(0, H-97, W, 97, fill=1, stroke=0)
    C.setFillColor(RED)
    C.rect(32, H-33, 34, 3, fill=1, stroke=0)
    txt(76, 25, "STREAMSHIELD / ENGINEERING REFERENCE", 8.7, True,
        colors.HexColor("#AFC7DF"))
    txt(32, 43, "SYSTEM ARCHITECTURE OF STREAMSHIELD", 25, True, colors.white)
    txt(33, 77, "Live broadcasting, resilient delivery and independently verified recovery",
        10, color=colors.HexColor("#C9D7E5"))
    txt(W-32, 27, "ONE PAGE · A3 LANDSCAPE", 9, True,
        colors.HexColor("#AFC7DF"), "right")

    pill(32, 111, 338, "CREATOR", "Camera / screen → browser Studio, or OBS", TEAL)
    pill(382, 111, 365, "AUDIENCE", "Watch / discovery · HLS playback · live chat", BLUE)
    pill(759, 111, W-791, "ADMINISTRATOR", "Control · health · incidents · logs · chaos", RED)

    # Media lane: arrows describe the direction of media bytes, not RTSP requests.
    panel(32, 172, 760, 155, "01", "MEDIA PLANE · capture → ingest → delivery", TEAL)
    media = [
        (48, 114, "Ingest relay", "MediaMTX<br/>WHIP / RTMP"),
        (195, 142, "Primary + standby", "MediaMTX ×2<br/>HLS packaging"),
        (370, 114, "Edge-1 + Edge-2", "Nginx<br/>segment caches"),
        (517, 116, "Video gateway", "Nginx<br/>edge failover"),
        (666, 110, "Web proxy", "Nginx /media/*<br/>→ HLS audience"),
    ]
    for x, width, title, body in media:
        node(x, 218, width, 61, title, body, TEAL)
    for end, start, label in [(162, 195, "RTSP"), (337, 370, "HLS"),
                              (484, 517, "HLS"), (633, 666, "HLS")]:
        arrow([(end, 249), (start, 249)], TEAL)
        txt((end+start)/2, 232, label, 7.2, color=TEAL, align="center")
    para(48, 289, 725,
         "<b>Creator ingest:</b> WHIP signaling uses /ingest/* via web; WebRTC ICE media goes directly to the relay. OBS uses RTMP.",
         size=8.5, leading=11, limit=22)
    para(48, 306, 725,
         "<b>Replication:</b> origins pull private authenticated RTSP. Primary/standby HLS paths remain distinct. MediaMTX remuxes; no ABR transcoder.",
         size=8.0, leading=10.5, color=MUTED, limit=11)

    # Application lane: client passes through the same web proxy as above.
    panel(32, 339, 760, 181, "02", "APPLICATION + DATA PLANE · metadata and chat", BLUE)
    node(48, 388, 145, 67, "Live / Studio / Control",
         "React 19 + TypeScript<br/>Query / Router / hls.js", BLUE)
    node(230, 388, 135, 67, "API gateway",
         "Nginx load balancing<br/>REST + Socket.IO", BLUE)
    node(402, 388, 141, 67, "API-1 + API-2",
         "Node.js 24 / Express 5<br/>Zod + ownership checks", BLUE)
    node(587, 374, 189, 53, "PostgreSQL 17",
         "Accounts, streams, chat, audit", BLUE)
    node(587, 441, 189, 53, "Redis 8",
         "Fanout, rate limits, presence", BLUE)
    arrow([(193, 422), (230, 422)], BLUE, both=True)
    arrow([(365, 422), (402, 422)], BLUE, both=True)
    arrow([(543, 406), (564, 406), (564, 400), (587, 400)], BLUE, both=True)
    arrow([(543, 437), (564, 437), (564, 467), (587, 467)], BLUE, both=True)
    txt(48, 369, "Browser ↔ same-origin web proxy ↔ /api/v1/* and /socket.io/*", 8.4,
        color=BLUE)
    para(48, 470, 510,
         "<b>Identity:</b> Argon2id passwords; hashed, revocable cookie sessions; CSRF/origin checks.<br/>"
         "<b>Publishing:</b> per-stream keys + private media-auth callbacks authorize ingest.<br/>"
         "<b>Separation:</b> Express handles metadata/permissions, not the audience video bytes.",
         size=8.4, leading=11.8, limit=38)

    # Reliability lane: distinguish observation, repair, fault injection and storage.
    cw = W-840
    panel(808, 172, cw, 348, "03", "RELIABILITY CONTROL", RED)
    txt(824, 202, "Independent processes; evidence drives every state", 8.3, color=MUTED)
    node(824, 228, 145, 51, "Observer", "Fresh probes + incidents", RED)
    node(995, 228, cw-203, 51, "Healer", "Policy + verification", RED)
    arrow([(969, 253), (995, 253)], RED)
    node(824, 306, 145, 51, "Chaos controller", "Admin + CSRF + target", RED)
    node(995, 306, cw-203, 51, "Repair adapter", "Allowlisted Docker actions", RED)
    arrow([(1068, 279), (1068, 306)], RED)
    txt(1080, 287, "lease / intent", 7.3, color=MUTED)
    node(824, 384, 145, 51, "Fault adapter", "Kill / bounded disruption", RED)
    node(995, 384, cw-203, 51, "Owned targets", "API-1 / gateway / Edge-1", RED)
    arrow([(896, 357), (896, 384)], RED, dashed=True)
    arrow([(969, 409), (995, 409)], RED, dashed=True)
    arrow([(1068, 357), (1068, 384)], RED)
    arrow([(W-48, 409), (W-40, 409), (W-40, 219), (896, 219), (896, 228)],
          MUTED, dashed=True, width=1)
    txt(824, 287, "Admin request → controlled experiment", 7.5, color=MUTED)
    txt(908, 365, "Separate fault authority", 7.3, color=MUTED)
    para(824, 446, cw-32,
         "<b>SQLite:</b> durable intents, leases and budgets.<br/>"
         "<b>PostgreSQL:</b> incident, recovery and experiment history.<br/>"
         "<b>Control UI:</b> authoritative REST + Socket.IO invalidations.<br/>"
         "<b>Proof:</b> healthy probes + application/HLS behavior; not a PID.<br/>"
         "<b>Network case:</b> Toxiproxy → simulated read-only dependency.",
         size=8.2, leading=12.5, limit=65)

    # Five failure families, including a clearly non-automatic restoration.
    txt(32, 535, "04", 10, True, RED)
    txt(58, 534, "FAILURE → DETECTION → RESTORATION → VISIBLE EFFECT", 11, True)
    txt(W-32, 536, "RTO = injection to independent service verification", 8.1,
        color=MUTED, align="right")
    widths = [135, 220, 365, W-32-32-135-220-365-86, 86]
    headers = ["FAILURE", "DETECTED BY", "RESTORATION + VERIFICATION", "LIVE-SYSTEM EFFECT", "LOCAL RTO"]
    top = 557
    C.setFillColor(INK)
    C.rect(32, H-top-24, W-64, 24, fill=1, stroke=0)
    x = 32
    for width, label in zip(widths, headers):
        txt(x+9, top+7, label, 7.8, True, colors.white)
        x += width
    times = {s["scenario"]: f"{s['recoveryMs']/1000:.3f} s" for s in DATA["scenarios"]}
    rows = [
        ("<b>API server crash</b>", "Readiness unreachable; confirmed probe failures.",
         "Healer starts API-1; readiness, catalog and gateway routing prove return.",
         "API-2 serves; video can keep playing.", times["crash-api"]),
        ("<b>Video gateway crash</b>", "Gateway probe and actual HLS delivery fail.",
         "Healer starts the gateway; valid, advancing HLS segments verify it.",
         "Buffer may drain, then playback resumes.", times["crash-video-gateway"]),
        ("<b>Edge node failure</b>", "Edge-1 probe fails; Edge-2 delivery observed.",
         "Healer starts Edge-1; live media verifies repair; peer stays unchanged.",
         "Edge-2 failover can preserve video.", times["crash-edge"]),
        ("<b>Network disruption</b>", "Toxiproxy delays safe recommendation reads; circuit opens.",
         "Owned 20 s delay expires; successful HALF_OPEN reads verify reconnection.",
         "Recommendations impaired; video separate.", times["network-timeout"]),
        ("<b>Media authority loss</b>", "Both HLS routes deny requests; buffered video drains.",
         "Operator restores simulated authority; advancing media must verify return.",
         "Video stops. Human restoration required.", "Unmeasured<br/><b>MANUAL</b>"),
    ]
    for index, row in enumerate(rows):
        y = top+24+index*25
        C.setFillColor(PALE if index % 2 == 0 else colors.white)
        C.rect(32, H-y-25, W-64, 25, fill=1, stroke=0)
        x = 32
        for width, cell in zip(widths, row):
            para(x+9, y+4, width-18, cell, size=7.9, leading=9.6, limit=20)
            x += width
    txt(32, 710,
        "Measured run a484d151: Linux + generated live source; timings are not Windows guarantees or viewer stall durations. Manual case: separate acceptance evidence.",
        7.7, color=MUTED)

    # Scope and trust are part of the architecture, not hidden in another page.
    rect(32, 730, 553, 72, fill=PALE)
    txt(44, 739, "DEPLOYMENT + TRUST BOUNDARY", 8.5, True, BLUE)
    para(44, 755, 529,
         "Docker Compose on one host: <b>13-container compact demo</b>. API-2 and control roles share one container; restricted API-2 cannot use its Docker socket. Only trusted adapters act.<br/>"
         "<b>5173:</b> persistent base app · <b>5174:</b> isolated ss-light-* streaming/chaos fixture. Faults stay in the owned demo project; the base app has no Healer by default.",
         size=8, leading=11, limit=45)
    rect(597, 730, W-629, 72, fill=PALE)
    txt(609, 739, "GUARDS + OPTIONAL FULL TOPOLOGY + LIMITS", 8.5, True, RED)
    para(609, 755, W-653,
         "Default: <b>2 repair operations/service/10 min + 30 s cooldown</b>. No restart of the last serving API; no automatic PostgreSQL repair. Healer is policy code, not an LLM.<br/>"
         "Optional full profile: Prometheus, Grafana, exporters and spare API-3. Single host/singletons remain limits; public deployment needs TLS, NAT/TURN, secrets and off-host recovery.",
         size=8, leading=11, limit=45)

    # Footer: link to implementation rather than publishing private runtime config.
    txt(32, 815, "main · fc9e1e1 application baseline · 27 October 2026 · 1 / 1", 7.4,
        color=MUTED)
    footer_links = [
        ("TECHNICAL GUIDE", "/blob/main/docs/TECHNICAL_GUIDE.md"),
        ("SOURCE CODE", "/tree/main"),
        ("RESILIENCE EVIDENCE", "/blob/main/docs/RESILIENCE_REPORT_DATA.json"),
    ]
    widths = [pdfmetrics.stringWidth(label, BOLD, 7.4) for label, _ in footer_links]
    x = W-32-sum(widths)-28
    for i, ((label, path), width) in enumerate(zip(footer_links, widths)):
        txt(x, 815, label, 7.4, True, BLUE)
        C.linkURL(REPO+path, (x, H-828, x+width, H-812), relative=0, thickness=0)
        x += width
        if i < 2:
            txt(x+5, 815, "/", 7.4, color=MUTED)
            x += 14
    C.showPage()
    C.save()
    print(f"Created {OUT.relative_to(ROOT)} — one A3 landscape page")


if __name__ == "__main__":
    build()
