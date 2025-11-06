import express from "express";
import { chromium } from "playwright";

const app = express();

/* ------------------------- SPEED / RELIABILITY ------------------------- */

// Reuse a single browser across requests (fast!)
let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      const b = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"]
      });
      return b;
    })();
  }
  return browserPromise;
}

// Tiny 15-minute in-memory cache
const cache = new Map(); // key -> { t, data }
const TTL = 15 * 60 * 1000;

/* ---------------------------- COSTCO FALLBACK -------------------------- */
// Costco exposes price/title in meta tags. We can fetch the HTML without rendering.
async function fetchCostcoMeta(targetUrl) {
  try {
    const resp = await fetch(targetUrl, {
      headers: {
        "accept-language": "en-CA,en;q=0.9",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36"
      }
    });
    if (!resp.ok) return null;
    const html = await resp.text();
    const price = (html.match(/property=["']product:price:amount["'][^>]*content=["']([^"']+)["']/i) || [])[1] || "";
    const title = (html.match(/property=["']og:title["'][^>]*content=["']([^"']+)["']/i) || [])[1] || "";
    return { c_price: price, c_title: title };
  } catch {
    return null;
  }
}

/* -------------------------------- ROUTES -------------------------------- */

app.get("/", (req, res) => res.send("OK"));
app.get("/health", (req, res) => res.json({ ok: true }));

// Main JSON API
app.get("/api/scrape", async (req, res) => {
  try {
    const { url, fields = "" } = req.query;
    const wanted = String(fields).split(",").map(s => s.trim()).filter(Boolean);
    if (!url || !wanted.length) return res.status(400).json({ error: "Missing url or fields" });

    const cacheKey = `${url}::${wanted.join(",")}`;
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.t < TTL) return res.json(hit.data);

    const out = {};
    const u = new URL(String(url));
    const hostname = u.hostname.toLowerCase();
    const isCostco = /\.costco\.ca$/.test(hostname);

    // --- COSTCO fast path (no headless navigation) ---
    if (isCostco && (wanted.includes("c_price") || wanted.includes("c_title"))) {
      const meta = await fetchCostcoMeta(url);
      if (meta) {
        if (wanted.includes("c_price")) out.c_price = meta.c_price;
        if (wanted.includes("c_title")) out.c_title = meta.c_title;
        const result = { headers: wanted, values: wanted.map(k => out[k] ?? ""), raw: out };
        cache.set(cacheKey, { t: Date.now(), data: result });
        return res.json(result);
      }
      // if meta failed, we’ll fall through to browser path as a last resort
    }

    // --- Headless browser path (Amazon and anything else) ---
    const browser = await getBrowser();
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36",
      locale: "en-CA",
      timezoneId: "America/Vancouver",
      ignoreHTTPSErrors: true
    });
    const page = await context.newPage();

    // Block heavy assets for speed
    await page.route("**/*", route => {
      const t = route.request().resourceType();
      if (["image", "media", "font"].includes(t)) return route.abort();
      route.continue();
    });

    await page.setExtraHTTPHeaders({ "Accept-Language": "en-CA,en;q=0.9" });

    // Fast but reliable load for Amazon
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1200);

    // Site-agnostic selectors (includes Amazon + generic meta)
    const selectors = {
      // Amazon (CA)
      price: [
        "#corePrice_feature_div .a-offscreen",
        "#apex_desktop .a-offscreen",
        "#tp_price_block_total_price_ww .a-offscreen",
        "#priceblock_ourprice",
        "#priceblock_dealprice"
      ],
      title: ["#productTitle", "meta[property='og:title']"],
      rating: ["#acrPopover .a-icon-alt", "span[data-hook='rating-out-of-text']"],

      // Generic/meta (used by a lot of stores)
      c_price: ["meta[property='product:price:amount']"],
      c_title: ["meta[property='og:title']"]
    };

    // Extract loop
    for (const key of wanted) {
      const cands = selectors[key] || [];
      let value = "";
      for (const sel of cands) {
        const el = await page.$(sel);
        if (!el) continue;
        if (sel.startsWith("meta[")) value = await el.getAttribute("content");
        else value = (await el.textContent())?.trim() || "";
        if (value) break;
      }
      if (key.includes("price") && value) {
        const num = value.replace(/[^\d.,]/g, "").replace(",", ".");
        const parsed = parseFloat(num);
        out[key] = Number.isNaN(parsed) ? value : parsed;
      } else {
        out[key] = value || "";
      }
    }

    await context.close();

    const result = { headers: wanted, values: wanted.map(k => out[k] ?? ""), raw: out };
    cache.set(cacheKey, { t: Date.now(), data: result });
    res.set("Cache-Control", "public, max-age=900");
    return res.json(result);
  } catch (e) {
    console.error("SCRAPE ERROR:", e);
    res.status(500).json({ error: e.message || "scrape error" });
  }
});

// CSV endpoint (faster in Google Sheets via IMPORTDATA)
app.get("/values", async (req, res) => {
  try {
    const base = `${req.protocol}://${req.get("host")}`;
    const u = `${base}/api/scrape?url=${encodeURIComponent(req.query.url || "")}&fields=${encodeURIComponent(req.query.fields || "")}`;
    const r = await fetch(u);
    const j = await r.json();
    const arr = j?.values || [];
    const csv = arr.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",");
    res.type("text/csv").send(csv);
  } catch (e) {
    res.type("text/csv").send("");
  }
});

/* ------------------------------ ERROR LOGGING -------------------------- */

process.on("unhandledRejection", err => console.error("UNHANDLED REJECTION:", err));
process.on("uncaughtException", err => console.error("UNCAUGHT EXCEPTION:", err));

const port = process.env.PORT || 8080;
const host = "0.0.0.0";
app.listen(port, host, () => console.log(`listening on ${host}:${port}`));
