import express from "express";
import { chromium } from "playwright";

const app = express();

app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/api/scrape", async (req, res) => {
  try {
    const { url, fields = "" } = req.query;
    const wanted = String(fields).split(",").map(s => s.trim()).filter(Boolean);
    if (!url || !wanted.length) return res.status(400).json({ error: "Missing url or fields" });

    const selectors = {
      // Amazon (CA)
      price: ["#corePrice_feature_div .a-offscreen", "#priceblock_ourprice", "#priceblock_dealprice"],
      title: ["#productTitle"],
      rating: ["#acrPopover .a-icon-alt"],
      // Costco (CA)
      c_price: ["meta[property='product:price:amount']"],
      c_title: ["meta[property='og:title']"]
    };

    const browser = await chromium.launch({
      headless: true, // boolean, not a string
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36"
    });

await page.route("**/*", route => {
  const t = route.request().resourceType();
  if (["image", "media", "font"].includes(t)) return route.abort();
  route.continue();
});

// 🟢 Tweak 1: Add language header (helps Costco, Amazon)
await page.setExtraHTTPHeaders({ "Accept-Language": "en-CA,en;q=0.9" });

// 🟢 Tweak 2: Use more reliable page load
await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(2500);


    const out = {};
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

    await browser.close();
    res.set("Cache-Control", "public, max-age=900");
    res.json({ headers: wanted, values: wanted.map(k => out[k] ?? ""), raw: out });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "scrape error" });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log("listening on " + port));
