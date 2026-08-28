const MAX_TEXT_BLOCKS = 80;
const MAX_CARD_CANDIDATES = 60;
const MAX_TABLE_ROWS = 40;

function cleanText(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
}

function isVisible(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    Number(style.opacity) !== 0 &&
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom >= 0 &&
    rect.right >= 0 &&
    rect.top <= window.innerHeight &&
    rect.left <= window.innerWidth
  );
}

function getVisibleText(element) {
  if (!isVisible(element)) return "";
  return cleanText(element.innerText || element.textContent || "");
}

function extractHeadings(root = document) {
  return Array.from(root.querySelectorAll("h1,h2,h3,h4,h5,h6,[role='heading']"))
    .filter(isVisible)
    .map((el) => ({
      level: el.tagName?.match(/^H\d$/i) ? Number(el.tagName.slice(1)) : Number(el.getAttribute("aria-level") || 0),
      text: getVisibleText(el),
    }))
    .filter((item) => item.text)
    .slice(0, 30);
}

function extractTables(root = document) {
  return Array.from(root.querySelectorAll("table"))
    .filter(isVisible)
    .map((table, index) => {
      const caption = cleanText(table.caption?.innerText || "");
      const rows = Array.from(table.querySelectorAll("tr"))
        .filter(isVisible)
        .slice(0, MAX_TABLE_ROWS)
        .map((row) =>
          Array.from(row.querySelectorAll("th,td"))
            .filter(isVisible)
            .map((cell) => cleanText(cell.innerText || cell.textContent || ""))
            .filter(Boolean)
        )
        .filter((row) => row.length);

      const header = rows[0] || [];
      const bodyRows = rows.slice(1);
      const records = header.length
        ? bodyRows.map((row) =>
            row.reduce((record, value, cellIndex) => {
              record[header[cellIndex] || `column_${cellIndex + 1}`] = value;
              return record;
            }, {})
          )
        : [];

      return {
        id: `table_${index + 1}`,
        caption,
        headers: header,
        rows: bodyRows,
        records,
      };
    })
    .filter((table) => table.headers.length || table.rows.length);
}

function extractKeyValueMetrics(root = document) {
  const bodyText = cleanText(root.body?.innerText || "");
  const metricPattern = /([A-Za-z][A-Za-z0-9 /_-]{2,40})\s*[:-]\s*([$]?\d[\d,]*(?:\.\d+)?%?|\d+(?:\.\d+)?\s*(?:students|users|orders|items|days|hrs|hours|mins|minutes))/g;
  const metrics = {};
  let match;

  while ((match = metricPattern.exec(bodyText)) !== null && Object.keys(metrics).length < 50) {
    const key = cleanText(match[1]).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    if (key && !metrics[key]) metrics[key] = cleanText(match[2]);
  }

  return metrics;
}

function extractCards(root = document) {
  const selectors = [
    "[class*='card' i]",
    "[class*='metric' i]",
    "[class*='stat' i]",
    "[class*='kpi' i]",
    "[data-card]",
    "[role='listitem']",
    "section",
    "article",
  ].join(",");

  return Array.from(root.querySelectorAll(selectors))
    .filter(isVisible)
    .map((el) => {
      const text = getVisibleText(el);
      const numbers = text.match(/[$]?\d[\d,]*(?:\.\d+)?%?/g) || [];
      return {
        label: cleanText(el.getAttribute("aria-label") || el.querySelector("h1,h2,h3,h4,h5,h6")?.innerText || ""),
        text,
        values: numbers.slice(0, 8),
      };
    })
    .filter((card) => card.text && card.text.length <= 600 && (card.values.length || card.label))
    .slice(0, MAX_CARD_CANDIDATES);
}

function extractTextBlocks(root = document) {
  const selectors = "p,li,dt,dd,label,span,strong,b,small";
  const seen = new Set();

  return Array.from(root.querySelectorAll(selectors))
    .filter(isVisible)
    .map(getVisibleText)
    .filter((text) => {
      if (!text || text.length < 3 || text.length > 300 || seen.has(text)) return false;
      seen.add(text);
      return true;
    })
    .slice(0, MAX_TEXT_BLOCKS);
}

export function extractDashboardData(root = document) {
  const title = cleanText(root.title || root.querySelector("title")?.textContent || "Dashboard");
  const bodyText = cleanText(root.body?.innerText || "");
  const headings = extractHeadings(root);
  const tables = extractTables(root);
  const cards = extractCards(root);
  const metrics = extractKeyValueMetrics(root);
  const textBlocks = extractTextBlocks(root);

  return {
    source: {
      title,
      url: window.location?.href || "",
      extractedAt: new Date().toISOString(),
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
    },
    headings,
    metrics,
    cards,
    tables,
    textBlocks,
    rawTextPreview: bodyText.slice(0, 6000),
    counts: {
      headings: headings.length,
      metrics: Object.keys(metrics).length,
      cards: cards.length,
      tables: tables.length,
      textBlocks: textBlocks.length,
    },
  };
}

export function hasDashboardData(data) {
  if (!data) return false;
  return Boolean(
    Object.keys(data.metrics || {}).length ||
    data.cards?.length ||
    data.tables?.length ||
    data.headings?.length ||
    data.rawTextPreview
  );
}
