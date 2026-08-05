//#region src/utils/url-site.ts
const TWO_PART_PUBLIC_SUFFIXES = new Set([
	"co.uk",
	"org.uk",
	"me.uk",
	"ac.uk",
	"gov.uk",
	"ltd.uk",
	"plc.uk",
	"com.au",
	"net.au",
	"org.au",
	"co.nz",
	"net.nz",
	"org.nz",
	"co.za",
	"org.za",
	"web.za",
	"co.jp",
	"ne.jp",
	"or.jp",
	"gr.jp",
	"co.kr",
	"or.kr",
	"ne.kr",
	"com.br",
	"net.br",
	"org.br",
	"com.mx",
	"com.ar",
	"com.co",
	"com.pe",
	"com.uy",
	"com.ec",
	"com.ve",
	"com.tr",
	"com.cn",
	"com.hk",
	"com.tw",
	"com.sg",
	"com.my",
	"com.ph",
	"com.vn",
	"co.in",
	"co.id",
	"co.th",
	"co.il",
	"com.sa",
	"com.eg",
	"com.ng",
	"co.ke",
	"com.pl",
	"com.ua",
	"com.gr",
	"com.pt",
	"com.ro"
]);
function registrableDomain(hostname) {
	const parts = hostname.toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
	if (parts.length <= 2) return parts.join(".");
	const lastTwo = parts.slice(-2).join(".");
	const labelCount = TWO_PART_PUBLIC_SUFFIXES.has(lastTwo) ? 3 : 2;
	return parts.slice(-labelCount).join(".");
}
function isSameSite(baseUrl, url) {
	try {
		const base = typeof baseUrl === "string" ? new URL(baseUrl) : baseUrl;
		const target = typeof url === "string" ? new URL(url) : url;
		if (target.protocol !== "http:" && target.protocol !== "https:") return false;
		const baseDomain = registrableDomain(base.hostname);
		return baseDomain !== "" && baseDomain === registrableDomain(target.hostname);
	} catch {
		return false;
	}
}

//#endregion
//#region src/utils/html.ts
function stripJsonLd(html) {
	return html.replace(/<script[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi, "");
}
function cleanHtml(html) {
	let cleaned = stripJsonLd(html);
	cleaned = cleaned.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<svg[\s\S]*?<\/svg>/gi, "").replace(/<noscript[\s\S]*?<\/noscript>/gi, "").replace(/<header[\s\S]*?<\/header>/gi, "").replace(/<footer[\s\S]*?<\/footer>/gi, "").replace(/<nav[\s\S]*?<\/nav>/gi, "").replace(/<form[\s\S]*?<\/form>/gi, "").replace(/\s(class|style|id|data-[a-z-]+|aria-[a-z-]+|on[a-z]+)=["'][^"']*["']/gi, "").replace(/<!--[\s\S]*?-->/g, "").replace(/\n{2,}/g, "\n").replace(/[ \t]{2,}/g, " ");
	return cleaned.trim();
}
function htmlToText(html) {
	return html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#?\w+;/g, " ").replace(/\s+/g, " ").trim();
}
function extractSupplementFactsFromHtml(html, customRegex) {
	const text = htmlToText(html);
	if (customRegex) try {
		const match = text.match(new RegExp(customRegex, "i"));
		const value = match?.[1] ?? match?.[0];
		if (value) return value.trim().replace(/\s+/g, " ").slice(0, 4e3);
	} catch {}
	for (const pattern of [
		/Compozi[țt]ie[\s:]+([\s\S]+?)(?:Mod de utilizare|Mod de administrare|Mod de folosire|Aten[țt]|Avertis|Contraindica)/i,
		/Ingrediente[\s:]+([\s\S]+?)(?:Mod de utilizare|Mod de administrare|Mod de folosire|Aten[țt]|Avertis|Contraindica)/i,
		/Supplement Facts[\s:]+([\s\S]+?)(?:Ingredients|Directions|Warnings|Suggested Use)/i,
		/Nutrition Facts[\s:]+([\s\S]+?)(?:Ingredients|Directions|Warnings|Suggested Use)/i
	]) {
		const match = text.match(pattern);
		if (match?.[1]) return match[1].trim().replace(/\s+/g, " ").slice(0, 4e3);
	}
	return "";
}

//#endregion
//#region src/pipeline/discovery-helpers.ts
function extractCategoryEntries(baseUrl, html) {
	const entries = [];
	const seen = /* @__PURE__ */ new Set();
	for (const link of extractLinks(baseUrl, html)) {
		if (!isSameSite(baseUrl, link.href) || shouldRejectUrl(link.href)) continue;
		const role = classifyCategoryRole(link);
		if (!role) continue;
		const key = `${role}:${link.href}`;
		if (seen.has(key)) continue;
		seen.add(key);
		entries.push({
			...link,
			role,
			score: scoreCategoryLink(link, role)
		});
	}
	return entries;
}
function extractMenuEntryCandidates(baseUrl, html) {
	const out = /* @__PURE__ */ new Map();
	for (const snippet of extractMenuSnippets(html)) for (const link of extractLinks(baseUrl, snippet.html)) {
		if (!isSameSite(baseUrl, link.href) || shouldRejectUrl(link.href)) continue;
		const kindHint = classifyMenuEntryKind(link);
		if (kindHint === "unknown") continue;
		const score = scoreMenuEntry(link, kindHint);
		const existing = out.get(link.href);
		if (existing) {
			existing.score = Math.max(existing.score, score);
			existing.sourceTabIds = mergeStrings(existing.sourceTabIds, [snippet.tabId]);
			existing.menuPath = mergeStrings(existing.menuPath, snippet.menuPath);
			continue;
		}
		out.set(link.href, {
			...link,
			kindHint,
			score,
			discoveredFrom: snippet.surface,
			menuPath: [...snippet.menuPath],
			sourceTabIds: snippet.tabId ? [snippet.tabId] : []
		});
	}
	return [...out.values()].sort((a, b) => b.score - a.score || a.href.localeCompare(b.href));
}
function extractFooterEntryCandidates(baseUrl, html) {
	const out = /* @__PURE__ */ new Map();
	const footerBlocks = [...html.matchAll(/<footer\b[\s\S]*?<\/footer>/gi), ...html.matchAll(/<[^>]+class=["'][^"']*\bfooter[^"']*["'][\s\S]*?<\/[^>]+>/gi)];
	for (const block of footerBlocks) for (const link of extractLinks(baseUrl, block[0] ?? "")) {
		if (!isSameSite(baseUrl, link.href) || shouldRejectUrl(link.href)) continue;
		const kindHint = classifyMenuEntryKind(link);
		if (kindHint === "unknown") continue;
		if (!(kindHint === "all" || looksLikeCategoryUrl(link.href) || looksLikeProductUrl(link.href))) continue;
		if (out.has(link.href)) continue;
		out.set(link.href, {
			...link,
			kindHint,
			score: Math.max(5, scoreMenuEntry(link, kindHint) - 25),
			discoveredFrom: "footer",
			menuPath: ["footer"],
			sourceTabIds: []
		});
	}
	return [...out.values()].sort((a, b) => b.score - a.score || a.href.localeCompare(b.href));
}
function collectStoreRootCandidates(baseUrl, html) {
	let baseHost;
	try {
		baseHost = new URL(baseUrl).hostname.toLowerCase().replace(/^www\./, "");
	} catch {
		return [];
	}
	const out = /* @__PURE__ */ new Map();
	const re = /<a\b([^>]*)>/gi;
	let match;
	const searchableHtml = stripNonRenderedLinkBlocks(html);
	while ((match = re.exec(searchableHtml)) !== null) {
		const rawHref = parseAttributes$1(match[1] ?? "").href?.trim();
		if (!rawHref || !/^https?:\/\//i.test(rawHref)) continue;
		let parsed;
		try {
			parsed = new URL(decodeHtml(rawHref));
		} catch {
			continue;
		}
		if (parsed.hostname.toLowerCase().replace(/^www\./, "") === baseHost) continue;
		if (!isSameSite(baseUrl, parsed)) continue;
		if ((parsed.pathname.replace(/\/+$/, "") || "/") !== "/") continue;
		const rootUrl = `${parsed.protocol}//${parsed.hostname.toLowerCase()}`;
		const score = /^(?:shop|store|shop\d*)\./.test(parsed.hostname.toLowerCase()) ? 2 : 1;
		out.set(rootUrl, Math.max(out.get(rootUrl) ?? 0, score));
	}
	return [...out.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([url]) => url);
}
function collectDetailUrls(baseUrl, html) {
	const urls = /* @__PURE__ */ new Set();
	for (const link of extractLinks(baseUrl, html)) {
		if (!isSameSite(baseUrl, link.href)) continue;
		if (looksLikeProductUrl(link.href)) urls.add(normalizeProductUrl(link.href));
	}
	return [...urls];
}
function collectLocalCategoryEntries(baseUrl, html, productUrls = []) {
	const productSet = new Set(productUrls.map((url) => normalizeProductUrl(url)));
	return extractCategoryEntries(baseUrl, extractListingBodyHtml(html)).filter((entry) => !productSet.has(normalizeProductUrl(entry.href)));
}
function findNextListingPage(baseUrl, html, visited = /* @__PURE__ */ new Set()) {
	const links = extractLinks(baseUrl, html);
	const nextCandidates = [];
	const numericCandidates = [];
	for (const link of links) {
		if (!isSameSite(baseUrl, link.href) || visited.has(normalizeUrl(link.href)) || shouldRejectUrl(link.href)) continue;
		const text = `${link.text} ${link.ariaLabel} ${link.title} ${link.className}`.toLowerCase();
		if (link.rel.toLowerCase().split(/\s+/).includes("next")) nextCandidates.push({
			href: normalizeUrl(link.href),
			score: 100
		});
		if (PAGINATION_NEXT_OR_MORE_RE.test(text)) nextCandidates.push({
			href: normalizeUrl(link.href),
			score: 90
		});
		const pageNumber = parsePageNumber(link.href, link.text);
		if (pageNumber !== null) numericCandidates.push({
			href: normalizeUrl(link.href),
			page: pageNumber
		});
	}
	nextCandidates.sort((a, b) => b.score - a.score);
	if (nextCandidates[0]) return nextCandidates[0].href;
	const inlinePaginationCandidates = extractInlinePaginationCandidates(baseUrl, html, visited);
	if (inlinePaginationCandidates[0]) return inlinePaginationCandidates[0].href;
	const currentPage = parsePageNumber(baseUrl, "") ?? 1;
	numericCandidates.sort((a, b) => a.page - b.page);
	const numeric = numericCandidates.find((candidate) => candidate.page > currentPage)?.href ?? null;
	if (numeric) return numeric;
	return null;
}
function extractLinks(baseUrl, html) {
	const links = [];
	const searchableHtml = stripNonRenderedLinkBlocks(html);
	const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
	let match;
	while ((match = re.exec(searchableHtml)) !== null) {
		const attrs = parseAttributes$1(match[1] ?? "");
		const rawHref = attrs.href?.trim();
		if (!rawHref || rawHref.startsWith("#") || /^javascript:/i.test(rawHref) || /^mailto:/i.test(rawHref) || /^tel:/i.test(rawHref)) continue;
		if (containsTemplatePlaceholder$1(rawHref)) continue;
		let href;
		try {
			href = normalizeUrl(new URL(decodeHtml(rawHref), baseUrl).toString());
		} catch {
			continue;
		}
		if (shouldRejectUrl(href)) continue;
		links.push({
			href,
			text: htmlToPlainText(match[2] ?? ""),
			rel: attrs.rel ?? "",
			ariaLabel: attrs["aria-label"] ?? "",
			className: attrs.class ?? "",
			title: attrs.title ?? ""
		});
	}
	const linkRe = /<link\b([^>]*)>/gi;
	while ((match = linkRe.exec(searchableHtml)) !== null) {
		const attrs = parseAttributes$1(match[1] ?? "");
		const rawHref = attrs.href?.trim();
		if (!rawHref || rawHref.startsWith("#") || /^javascript:/i.test(rawHref) || /^mailto:/i.test(rawHref) || /^tel:/i.test(rawHref)) continue;
		if (containsTemplatePlaceholder$1(rawHref)) continue;
		let href;
		try {
			href = normalizeUrl(new URL(decodeHtml(rawHref), baseUrl).toString());
		} catch {
			continue;
		}
		if (shouldRejectUrl(href)) continue;
		links.push({
			href,
			text: "",
			rel: attrs.rel ?? "",
			ariaLabel: "",
			className: attrs.class ?? "",
			title: attrs.title ?? ""
		});
	}
	return links;
}
function extractListingBodyHtml(html) {
	const main = html.match(/<main\b[^>]*>[\s\S]*?<\/main>/i)?.[0];
	if (main) return stripNonRenderedLinkBlocks(main);
	return stripNonRenderedLinkBlocks(html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html).replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<header\b[\s\S]*?<\/header>/gi, " ").replace(/<nav\b[\s\S]*?<\/nav>/gi, " ").replace(/<footer\b[\s\S]*?<\/footer>/gi, " ");
}
function normalizeProductUrl(url) {
	const parsed = new URL(url);
	parsed.hash = "";
	for (const key of [...parsed.searchParams.keys()]) if (/^(?:categorycode|utm_|fbclid|gclid|currency|lang)/i.test(key)) parsed.searchParams.delete(key);
	return finalizeNormalizedUrl(parsed);
}
function normalizeUrl(url) {
	const parsed = new URL(url);
	parsed.hash = "";
	return finalizeNormalizedUrl(parsed);
}
function looksLikeProductUrl(url) {
	try {
		const path = new URL(url).pathname.toLowerCase();
		if (shouldRejectUrl(url)) return false;
		if (looksLikeListingCodePage(path)) return false;
		if (/\/(?:menu|category|categories|collection|collections|catalog|shop|store)(?:\/|$)/.test(path) && !/\/(?:product|products|produs|produit|producto)\//.test(path)) return false;
		return /\/(?:product|products|produs|produit|producto|produkt|item|p)\//.test(path) || /\/p\//.test(path) || /(?:^|\/)[^/?#]+-opis\d+\.html$/.test(path) || /(?:^|\/)[^/?#]+-\d{3,}\.html$/.test(path) || /(?:^|\/)p\d{3,}[-_][^/?#]+\.(?:php|html?)$/.test(path);
	} catch {
		return false;
	}
}
function looksLikeCategoryUrl(url) {
	try {
		const path = new URL(url).pathname.toLowerCase();
		if (shouldRejectUrl(url) || looksLikeProductUrl(url)) return false;
		return /\/(?:collections?|categories?|category|catalog|shop|store|menu|products|produkty|produits|productos|produkte)(?:\/|$)/.test(path) || looksLikeListingCodePage(path);
	} catch {
		return false;
	}
}
function shouldRejectUrl(url) {
	if (containsTemplatePlaceholder$1(url)) return true;
	try {
		const path = new URL(url).pathname.toLowerCase();
		const normalizedPath = path.replace(/\/+$/, "") || "/";
		if (normalizedPath === "/") return true;
		if (/\.(?:jpg|jpeg|png|webp|gif|svg|css|js|xml|json|pdf|zip|woff2?)(?:$|\?)/i.test(path)) return true;
		if (/(?:^|\/)blog(?:[-/]|$)|-blog\d+\.html$/.test(path)) return true;
		if (/^\/(?:global|locale|language|languages|region|regions|country|countries)$/i.test(normalizedPath)) return true;
		if (/^\/(?:privacy(?:[-/]and[-/])?cookies?|cookies?(?:[-/]policy)?|privacy[-/]policy|terms(?:[-/]and[-/]conditions)?|about(?:[-/]us)?|contact(?:[-/]us)?)$/i.test(normalizedPath)) return true;
		return /\/(?:cart|basket|checkout|account|login|register|wishlist|search|blog|news|contact|about|privacy|terms|faq|client-|order|compare|producer|producers|brand|brands)(?:\/|$)/.test(path);
	} catch {
		return true;
	}
}
function visibleLinkText(link) {
	return `${link.text} ${link.ariaLabel} ${link.title}`.trim().replace(/\s+/g, " ").toLowerCase();
}
function mergeStrings(existing, values) {
	return [...new Set([...existing, ...values].filter(Boolean))];
}
function classifyCategoryRole(link) {
	const text = visibleLinkText(link);
	const path = safePath(link.href);
	if (looksLikeProductUrl(link.href)) return null;
	if (isAllProductsLink(text, path)) return "all";
	if (looksLikeCategoryUrl(link.href) || CATEGORY_TEXT_RE.test(text)) return "category";
	return null;
}
function scoreCategoryLink(link, role) {
	const text = visibleLinkText(link);
	const path = safePath(link.href);
	let score = role === "all" ? 100 : 50;
	if (role === "all" && /^(shop|all|all products|shop all|view all|browse all|new products)$/i.test(text)) score += 25;
	if (path.split("/").filter(Boolean).length <= 3) score += 10;
	if (/(?:header|nav|menu)/i.test(link.className)) score += 5;
	return score;
}
function classifyMenuEntryKind(link) {
	const text = visibleLinkText(link);
	if (isAllProductsLink(text, safePath(link.href))) return "all";
	if (looksLikeProductUrl(link.href)) return "products";
	if (looksLikeCategoryUrl(link.href) || CATEGORY_TEXT_RE.test(text)) return "category";
	return "unknown";
}
function scoreMenuEntry(link, kind) {
	const path = safePath(link.href);
	let score = 40;
	if (kind === "all") score += 60;
	if (kind === "products") score += 25;
	if (kind === "category") score += 20;
	if (path.split("/").filter(Boolean).length <= 3) score += 10;
	if (/(?:menu|nav|header)/i.test(link.className)) score += 5;
	if (/^(?:all|all products|shop all|view all|browse all|products|shop)$/i.test(visibleLinkText(link))) score += 10;
	return score;
}
function parsePageNumber(href, text) {
	const textNumber = text.trim().match(/^\d{1,4}$/)?.[0];
	if (textNumber) return Number(textNumber);
	try {
		const url = new URL(href);
		const counter = url.searchParams.get("counter");
		if (counter && /^\d{1,4}$/.test(counter)) return Number(counter) + 1;
		for (const key of [
			"page",
			"p",
			"paged"
		]) {
			const value = url.searchParams.get(key);
			if (value && /^\d{1,4}$/.test(value)) return Number(value);
		}
		const match = url.pathname.match(/\/page\/(\d{1,4})(?:\/|$)/i);
		return match?.[1] ? Number(match[1]) : null;
	} catch {
		return null;
	}
}
function extractInlinePaginationCandidates(baseUrl, html, visited) {
	const candidates = [];
	for (const node of extractInteractiveElements(baseUrl, html)) {
		const text = `${node.text} ${node.ariaLabel} ${node.title} ${node.className}`.toLowerCase();
		if (!PAGINATION_NEXT_OR_MORE_RE.test(text)) continue;
		const nextUrl = extractNextUrlFromNode(baseUrl, node.attrs);
		if (!nextUrl) continue;
		if (!isSameSite(baseUrl, nextUrl) || visited.has(normalizeUrl(nextUrl)) || shouldRejectUrl(nextUrl)) continue;
		candidates.push({
			href: normalizeUrl(nextUrl),
			score: 95
		});
	}
	return candidates.sort((a, b) => b.score - a.score || a.href.localeCompare(b.href));
}
function extractNextUrlFromNode(baseUrl, attrs) {
	const direct = attrs.href || attrs["data-next-url"] || attrs["data-url"];
	if (direct) {
		const resolved = resolveMaybeRelativeUrl(baseUrl, direct);
		if (resolved && looksSafePaginationUrl(resolved)) return resolved;
	}
	for (const key of [
		"onclick",
		"@click",
		"x-on:click",
		"x-on:click.prevent",
		"data-action",
		"data-click"
	]) {
		const value = attrs[key];
		if (!value) continue;
		const extracted = extractUrlFromActionValue(baseUrl, value);
		if (extracted && looksSafePaginationUrl(extracted)) return extracted;
	}
	return null;
}
function extractUrlFromActionValue(baseUrl, value) {
	const literalMatches = value.matchAll(/["'`](\/[^"'`]+|https?:\/\/[^"'`]+)["'`]/gi);
	for (const match of literalMatches) {
		const candidate = resolveMaybeRelativeUrl(baseUrl, match[1] ?? "");
		if (candidate && looksSafePaginationUrl(candidate)) return candidate;
	}
	return null;
}
function looksSafePaginationUrl(url) {
	try {
		const parsed = new URL(url);
		if (parsePageNumber(parsed.toString(), "") !== null) return true;
		return /\/page\/\d{1,4}(?:\/|$)/i.test(parsed.pathname);
	} catch {
		return false;
	}
}
function looksLikeListingCodePage(path) {
	return /(?:^|\/)[^/?#]+-(?:k|cat|category|collection|brand|producer|p)\d+\.html$/.test(path);
}
function isAllProductsLink(text, path) {
	const normalizedPath = path.replace(/\/+$/, "");
	return ALL_TEXT_RE.test(text) || /\/collections\/(?:all|shop-all)$/i.test(normalizedPath) || /\/(?:all-products|shop-all|products|shop|store)$/i.test(normalizedPath) || /\/menu\/shop-\d+\.html$/i.test(normalizedPath);
}
function safePath(url) {
	try {
		return new URL(url).pathname.toLowerCase();
	} catch {
		return "";
	}
}
function parseAttributes$1(input) {
	const attrs = {};
	const attrRe = /([@a-zA-Z_:][-@a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
	let match;
	while ((match = attrRe.exec(input)) !== null) {
		const key = match[1]?.toLowerCase();
		const value = match[2] ?? match[3] ?? match[4] ?? "";
		if (key) attrs[key] = decodeHtml(value);
	}
	return attrs;
}
function htmlToPlainText(input) {
	return decodeHtml(input.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}
function decodeHtml(value) {
	return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}
function finalizeNormalizedUrl(parsed) {
	const serialized = parsed.toString();
	if (parsed.pathname === "/" && !parsed.search) return serialized.replace(/\/$/, "");
	return serialized;
}
function extractInteractiveElements(baseUrl, html) {
	const out = [];
	const searchableHtml = stripNonRenderedLinkBlocks(html);
	const re = /<(a|button|div|span)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
	let match;
	while ((match = re.exec(searchableHtml)) !== null) {
		const tag = (match[1] ?? "").toLowerCase();
		const attrs = parseAttributes$1(match[2] ?? "");
		const rawHref = attrs.href?.trim();
		let href = "";
		if (rawHref && !rawHref.startsWith("#") && !/^javascript:/i.test(rawHref)) href = resolveMaybeRelativeUrl(baseUrl, rawHref) ?? "";
		out.push({
			href,
			text: htmlToPlainText(match[3] ?? ""),
			rel: attrs.rel ?? "",
			ariaLabel: attrs["aria-label"] ?? "",
			className: attrs.class ?? "",
			title: attrs.title ?? "",
			tag,
			attrs
		});
	}
	return out;
}
function resolveMaybeRelativeUrl(baseUrl, value) {
	const raw = decodeHtml(value).trim();
	if (!raw || raw.startsWith("#") || /^javascript:/i.test(raw) || /^mailto:/i.test(raw) || /^tel:/i.test(raw)) return null;
	if (containsTemplatePlaceholder$1(raw)) return null;
	try {
		const normalized = normalizeUrl(new URL(raw, baseUrl).toString());
		return shouldRejectUrl(normalized) ? null : normalized;
	} catch {
		return null;
	}
}
function stripNonRenderedLinkBlocks(html) {
	return html.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<template\b[\s\S]*?<\/template>/gi, " ").replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ").replace(/<svg\b[\s\S]*?<\/svg>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
}
function containsTemplatePlaceholder$1(value) {
	const decoded = decodeTemplatePlaceholderValue$1(value);
	return /(?:\{\{|\}\}|<%|%>|\$\{)/.test(decoded);
}
function decodeTemplatePlaceholderValue$1(value) {
	let decoded = decodeHtml(value);
	for (let i = 0; i < 2; i += 1) try {
		const next = decodeURIComponent(decoded);
		if (next === decoded) break;
		decoded = next;
	} catch {
		break;
	}
	return decoded;
}
function extractMenuSnippets(html) {
	const snippets = [];
	for (const { surface, re } of [
		{
			surface: "header_nav",
			re: /<nav\b[\s\S]*?<\/nav>/gi
		},
		{
			surface: "header_nav",
			re: /<header\b[\s\S]*?<\/header>/gi
		},
		{
			surface: "mobile_menu",
			re: /<[^>]+class=["'][^"']*\b(?:mobile-menu|off-canvas|drawer|hamburger-menu)[^"']*["'][\s\S]*?<\/[^>]+>/gi
		},
		{
			surface: "mega_menu",
			re: /<[^>]+class=["'][^"']*\b(?:mega-menu|dropdown-menu|submenu|sub-menu|menu-panel)[^"']*["'][\s\S]*?<\/[^>]+>/gi
		}
	]) {
		let index = 0;
		for (const match of html.matchAll(re)) {
			const snippetHtml = match[0];
			if (!snippetHtml) continue;
			snippets.push({
				html: snippetHtml,
				surface,
				tabId: `${surface}:${index++}`,
				menuPath: [surface]
			});
		}
	}
	return snippets.length > 0 ? snippets : [{
		html,
		surface: "header_nav",
		tabId: "header_nav:0",
		menuPath: ["header_nav"]
	}];
}
const ALL_TEXT_RE = /^(?:all|all products|shop|shop all|view all|browse all|new products|all items|products|our products|toate produsele|vezi toate|tous les produits|voir tout|boutique|alle produkte|alle ansehen|todos los productos|ver todos|tienda|tutti i prodotti|vedi tutto|negozio|todos os produtos|loja|wszystkie produkty|sklep|všechny produkty|obchod|e-?shop|webshop|alle producten|winkel|alla produkter|alle produkter|kaikki tuotteet|tüm ürünler|mağaza|все товары|все продукты|магазин|全部商品|所有商品|所有产品|全部产品|商城|すべての商品|全商品|商品一覧|전체 ?상품|모든 제품)$/i;
const CATEGORY_TEXT_RE = /(?:category|categories|collection|collections|shop|store|menu|supplements|nutrition|vitamins|proteins|healthy supplements|new products|catalog(?:ue)?|catalogo|catálogo|katalog|prodotti|categorie\b|integratori|productos|categorías|categorias|suplementos|vitaminas|produtos|produits|catégories|compléments|produkte|kategorien|nahrungsergänzung|sortiment|producten|categorieën|assortiment|produkty|kategorie\b|suplementy|doplňky|produse|categorii|suplimente|ürünler|kategoriler|товары|продукты|каталог|категории|витамины|产品|商品|分类|品类|제품|상품|카테고리|製品|カテゴリ)/i;
const PAGINATION_NEXT_TEXT_PATTERN = "\\bnext\\b|next page|older|następna|dalej|suivant|page suivante|weiter|nächste|siguiente|página siguiente|successiva|avanti|seguinte|próxima|volgende|nästa|næste|neste|seuraava|další|následující|sonraki|далее|следующая|次へ|次のページ|다음|下一页|下一頁";
const PAGINATION_MORE_TEXT_PATTERN = "load more|show more|view more|see more|more products|mehr laden|mehr anzeigen|weitere produkte|mostra altri|carica altri|mostra di più|voir plus|afficher plus|charger plus|cargar más|ver más|mostrar más|más productos|mais produtos|carregar mais|ver mais|toon meer|meer laden|pokaż więcej|załaduj więcej|zobrazit více|načíst další|visa fler|vis flere|vis mere|näytä lisää|daha fazla|показать ещё|показать еще|загрузить ещё|загрузить еще|加载更多|查看更多|显示更多|更多商品|もっと見る|さらに表示|더 ?보기";
const PAGINATION_NEXT_OR_MORE_RE = new RegExp(`(?:${PAGINATION_NEXT_TEXT_PATTERN}|${PAGINATION_MORE_TEXT_PATTERN}|>|»|›)`, "i");

//#endregion
//#region src/pipeline/platform-enumeration.ts
const SHOPIFY_PRODUCTS_PAGE_SIZE = 250;
const SHOPIFY_MAX_PAGES = 40;
const SITEMAP_MAX_CHILD_SITEMAPS = 5;
const SITEMAP_MAX_CATEGORY_URLS = 30;
async function enumerateShopifyProducts(siteUrl, fetcher, maxItems, opts = {}) {
	let origin;
	try {
		origin = new URL(siteUrl).origin;
	} catch {
		return null;
	}
	const urls = [];
	const seen = /* @__PURE__ */ new Set();
	const maxPages = Math.min(SHOPIFY_MAX_PAGES, Math.max(1, Math.ceil(maxItems / SHOPIFY_PRODUCTS_PAGE_SIZE)));
	let pagesFetched = 0;
	for (let page = 1; page <= maxPages; page += 1) {
		let products;
		try {
			const response = await fetcher(`${origin}/products.json?limit=${SHOPIFY_PRODUCTS_PAGE_SIZE}&page=${page}`, { signal: opts.signal });
			if (response.status !== 200) return page === 1 ? null : {
				platform: "shopify",
				urls,
				complete: false,
				pagesFetched
			};
			const parsed = JSON.parse(response.body);
			if (!Array.isArray(parsed.products)) return page === 1 ? null : {
				platform: "shopify",
				urls,
				complete: false,
				pagesFetched
			};
			products = parsed.products;
		} catch {
			return page === 1 ? null : {
				platform: "shopify",
				urls,
				complete: false,
				pagesFetched
			};
		}
		pagesFetched += 1;
		for (const product of products) {
			if (typeof product?.handle !== "string" || product.handle === "") continue;
			const url = `${origin}/products/${product.handle}`;
			if (seen.has(url)) continue;
			seen.add(url);
			urls.push(url);
			if (urls.length >= maxItems) return {
				platform: "shopify",
				urls,
				complete: true,
				pagesFetched
			};
		}
		if (products.length < SHOPIFY_PRODUCTS_PAGE_SIZE) return {
			platform: "shopify",
			urls,
			complete: true,
			pagesFetched
		};
	}
	return {
		platform: "shopify",
		urls,
		complete: urls.length >= maxItems,
		pagesFetched
	};
}
async function nominateEntriesFromSitemap(siteUrl, fetcher, maxProducts, opts = {}) {
	let origin;
	try {
		origin = new URL(siteUrl).origin;
	} catch {
		return null;
	}
	const rootBody = await fetchSitemapBody(`${origin}/sitemap.xml`, fetcher, opts.signal);
	if (!rootBody) return null;
	const bodies = [];
	let sitemapsFetched = 1;
	if (/<sitemapindex/i.test(rootBody)) {
		const childUrls = extractLocUrls(rootBody).filter((url) => isSameSite(siteUrl, url)).sort((a, b) => sitemapChildPriority(b) - sitemapChildPriority(a)).slice(0, SITEMAP_MAX_CHILD_SITEMAPS);
		for (const childUrl of childUrls) {
			const childBody = await fetchSitemapBody(childUrl, fetcher, opts.signal);
			if (!childBody) continue;
			sitemapsFetched += 1;
			bodies.push(childBody);
		}
	} else bodies.push(rootBody);
	const categoryUrls = /* @__PURE__ */ new Set();
	const productUrls = /* @__PURE__ */ new Set();
	for (const body of bodies) for (const rawUrl of extractLocUrls(body)) {
		if (!isSameSite(siteUrl, rawUrl) || shouldRejectUrl(rawUrl)) continue;
		if (looksLikeProductUrl(rawUrl)) {
			if (productUrls.size < maxProducts) productUrls.add(normalizeProductUrl(rawUrl));
		} else if (looksLikeCategoryUrl(rawUrl)) {
			if (categoryUrls.size < SITEMAP_MAX_CATEGORY_URLS) categoryUrls.add(normalizeUrl(rawUrl));
		}
	}
	if (categoryUrls.size === 0 && productUrls.size === 0) return null;
	return {
		categoryUrls: [...categoryUrls],
		productUrls: [...productUrls],
		sitemapsFetched
	};
}
async function fetchSitemapBody(url, fetcher, signal) {
	try {
		const response = await fetcher(url, { signal });
		if (response.status !== 200) return null;
		const body = response.body?.trim() ?? "";
		if (!/<(?:urlset|sitemapindex)/i.test(body)) return null;
		return body;
	} catch {
		return null;
	}
}
function extractLocUrls(body) {
	const urls = [];
	for (const match of body.matchAll(/<loc>\s*([^<\s][^<]*?)\s*<\/loc>/gi)) {
		const url = decodeXmlEntities(match[1] ?? "");
		if (url) urls.push(url);
	}
	return urls;
}
function sitemapChildPriority(url) {
	if (/product/i.test(url)) return 3;
	if (/collection|category/i.test(url)) return 2;
	if (/page/i.test(url)) return 1;
	return 0;
}
function decodeXmlEntities(value) {
	return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'");
}

//#endregion
//#region src/utils/image.ts
const DEFAULT_PREFERRED_SOURCE_ORDER = [
	"anchor_href",
	"data_zoom_src",
	"data_large_image",
	"data_original",
	"data_master",
	"srcset",
	"img_src",
	"data_src",
	"css_background",
	"meta"
];
const ORIGINAL_IMAGE_RESOLVERS = [
	{
		kind: "magento_catalog_cache",
		resolve(url) {
			const match = url.pathname.match(/^(.*\/media\/catalog\/product)\/cache\/([a-f0-9]{16,64})\/(.+)$/i);
			if (!match) return null;
			const original = new URL(url);
			original.pathname = `${match[1]}/${match[3]}`;
			return original;
		},
		validationGroup(url) {
			const cacheKey = url.pathname.match(/\/cache\/([a-f0-9]{16,64})\//i)?.[1] ?? "unknown";
			return `${url.origin}:${cacheKey}`;
		}
	},
	{
		kind: "wordpress_dimensions",
		resolve(url) {
			if (!url.pathname.includes("/wp-content/uploads/")) return null;
			const stripped = stripWpThumbSuffix(url.toString());
			return stripped === url.toString() ? null : new URL(stripped);
		},
		validationGroup(url) {
			return url.origin;
		}
	},
	{
		kind: "shopify_transform",
		resolve(url) {
			if (!(url.hostname === "cdn.shopify.com" || url.pathname.includes("/cdn/shop/"))) return null;
			const original = new URL(url);
			original.searchParams.delete("width");
			original.searchParams.delete("height");
			original.pathname = original.pathname.replace(/_(?:pico|icon|thumb|small|compact|medium|large|grande|master|\d{2,5}x\d{0,5}|\d{0,5}x\d{2,5})(?:_crop_[a-z]+)?(?=\.(?:jpe?g|png|webp|gif)$)/i, "");
			return original.toString() === url.toString() ? null : original;
		},
		validationGroup(url) {
			const pathParts = url.pathname.split("/").filter(Boolean);
			const accountPrefix = url.hostname === "cdn.shopify.com" ? pathParts.slice(0, 4).join("/") : "storefront";
			return `${url.origin}:${accountPrefix}`;
		}
	},
	{
		kind: "bigcommerce_stencil",
		resolve(url) {
			const match = url.pathname.match(/^(.*\/images\/stencil\/)(\d{2,5}x\d{2,5})(\/products\/.+)$/i);
			if (!match) return null;
			const original = new URL(url);
			original.pathname = `${match[1]}original${match[3]}`;
			return original;
		},
		validationGroup(url) {
			return url.origin;
		}
	},
	{
		kind: "cloudinary_transform",
		resolve(url) {
			if (url.hostname !== "res.cloudinary.com") return null;
			const match = url.pathname.match(/^(.*\/image\/upload\/)([^/]+)(\/.+)$/i);
			if (!match || /^s--.+--$/i.test(match[2] ?? "")) return null;
			const parts = (match[2] ?? "").split(",");
			if (!(parts.length > 0 && parts.every((part) => /^(?:ar|c|dpr|f|fl|g|h|q|r|t|w|x|y|z)_.+$/i.test(part)))) return null;
			const original = new URL(url);
			original.pathname = `${match[1]}${match[3]?.replace(/^\//, "")}`;
			return original;
		},
		validationGroup(url) {
			const cloudName = url.pathname.split("/").filter(Boolean)[0] ?? "unknown";
			return `${url.origin}:${cloudName}`;
		}
	},
	{
		kind: "imagekit_transform",
		resolve(url) {
			if (url.hostname !== "ik.imagekit.io") return null;
			const original = new URL(url);
			original.searchParams.delete("tr");
			original.pathname = original.pathname.replace(/\/tr:[^/]+\//i, "/");
			return original.toString() === url.toString() ? null : original;
		},
		validationGroup(url) {
			const account = url.pathname.split("/").filter(Boolean)[0] ?? "unknown";
			return `${url.origin}:${account}`;
		}
	}
];
const ORIGINAL_IMAGE_RESOLVER_KINDS = ORIGINAL_IMAGE_RESOLVERS.map((resolver) => resolver.kind);
function stripWpThumbSuffix(url) {
	return url.replace(/-\d{2,5}x\d{2,5}(?=\.(?:jpe?g|png|webp|gif)(?:[?#]|$))/i, "");
}
/**
* Derive a likely original asset URL from a known CDN/platform transform.
*
* This function only proposes a candidate. Callers that can perform I/O must
* validate it before replacing `sourceUrl`; a failed validation keeps the
* source URL untouched.
*/
function deriveOriginalImageCandidate(url, baseUrl) {
	let source;
	try {
		source = baseUrl ? new URL(url, baseUrl) : new URL(url);
	} catch {
		return null;
	}
	if (!/^https?:$/.test(source.protocol)) return null;
	for (const resolver of ORIGINAL_IMAGE_RESOLVERS) {
		const original = resolver.resolve(source);
		if (!original || original.toString() === source.toString()) continue;
		return {
			sourceUrl: source.toString(),
			originalUrl: original.toString(),
			resolver: resolver.kind,
			validationGroup: `${resolver.kind}:${resolver.validationGroup(source)}`
		};
	}
	return null;
}
/** Stable identity for deduping transformed and original variants together. */
function imageIdentityKey(url, baseUrl) {
	const candidate = deriveOriginalImageCandidate(url, baseUrl);
	const identity = imageProxyTarget(url, baseUrl) ?? candidate?.originalUrl ?? url;
	try {
		const parsed = baseUrl ? new URL(identity, baseUrl) : new URL(identity);
		if (parsed.protocol === "http:" || parsed.protocol === "https:") parsed.protocol = "https:";
		parsed.hash = "";
		return parsed.toString();
	} catch {
		return identity;
	}
}
function imageProxyTarget(url, baseUrl) {
	try {
		const parsed = baseUrl ? new URL(url, baseUrl) : new URL(url);
		if (!/(?:thumb|image|resize|proxy)\.php$/i.test(parsed.pathname)) return null;
		const target = parsed.searchParams.get("img") || parsed.searchParams.get("image");
		if (!target || !/^https?:\/\//i.test(target)) return null;
		if (!/\.(?:jpe?g|png|webp|gif)(?:[?#]|$)/i.test(target)) return null;
		return target;
	} catch {
		return null;
	}
}
function normalizeImageUrl(url, baseUrl) {
	return stripWpThumbSuffix(baseUrl ? new URL(url, baseUrl).toString() : url);
}
function pickBestSrcset(srcset, baseUrl) {
	const candidates = srcset.split(",").map((part) => part.trim()).filter(Boolean).map((part) => {
		const [url = "", descriptor = ""] = part.split(/\s+/, 2);
		const widthMatch = descriptor.match(/^(\d+)w$/);
		const densityMatch = descriptor.match(/^(\d+(?:\.\d+)?)x$/);
		return {
			url,
			score: widthMatch ? Number(widthMatch[1]) : densityMatch ? Number(densityMatch[1]) * 1e3 : 0
		};
	}).filter((candidate) => candidate.url);
	candidates.sort((a, b) => b.score - a.score);
	const best = candidates[0]?.url ?? "";
	return best ? normalizeImageUrl(best, baseUrl) : "";
}
function uniqueImages(images) {
	const out = [];
	const indexes = /* @__PURE__ */ new Map();
	for (const image of images) {
		if (!image) continue;
		const identity = imageIdentityKey(image);
		const existingIndex = indexes.get(identity);
		if (existingIndex === void 0) {
			indexes.set(identity, out.length);
			out.push(image);
			continue;
		}
		if (imagePreference(image) > imagePreference(out[existingIndex] ?? "")) out[existingIndex] = image;
	}
	return out;
}
function imagePreference(url) {
	let score = deriveOriginalImageCandidate(url) ? 0 : 4;
	try {
		if (new URL(url).protocol === "https:") score += 2;
	} catch {}
	return score;
}
function collectDetailPageImageCandidates(html, baseUrl, opts = {}) {
	const candidates = [];
	const productHints = buildProductHints(opts.productTitle, opts.productUrl ?? baseUrl);
	const galleryRanges = collectGalleryRanges(html);
	let index = 0;
	const addContextual = (raw, sourceType, score, attrs, context, matchIndex) => {
		const url = normalizeCandidate(raw, baseUrl);
		if (!url || shouldRejectImage(url)) return;
		const openedFromGallery = isInsideRanges(matchIndex, galleryRanges);
		if (!openedFromGallery && !isProductMediaCandidate(url, attrs, context, productHints, opts.galleryContainerHints ?? [])) return;
		const candidate = {
			url,
			sourceType,
			containerFingerprint: fingerprintContainerContext(context),
			context,
			alt: attrs.alt,
			title: attrs.title,
			baseScore: score + imageUrlScore(url),
			index: index++,
			openedFromGallery,
			labels: labelCandidateHeuristically(url, attrs, context, openedFromGallery)
		};
		candidates.push(candidate);
	};
	const addMeta = (raw, matchIndex) => {
		const url = normalizeCandidate(raw, baseUrl);
		if (!url || shouldRejectImage(url)) return;
		candidates.push({
			url,
			sourceType: "meta",
			containerFingerprint: "meta",
			context: "",
			baseScore: 100 + imageUrlScore(url),
			index: index++,
			openedFromGallery: isInsideRanges(matchIndex, galleryRanges),
			labels: []
		});
	};
	collectMatches(html, /<(?:meta|link)\b[^>]*(?:property|name|rel)=["'](?:og:image(?::secure_url)?|twitter:image(?::src)?|image_src)["'][^>]*(?:content|href)=["']([^"']+)["'][^>]*>/gi, (match) => addMeta(match[1], match.index));
	collectMatches(html, /<(?:meta|link)\b[^>]*(?:content|href)=["']([^"']+)["'][^>]*(?:property|name|rel)=["'](?:og:image(?::secure_url)?|twitter:image(?::src)?|image_src)["'][^>]*>/gi, (match) => addMeta(match[1], match.index));
	collectMatches(html, /<(?:img|source)\b([^>]+)>/gi, (match) => {
		const attrs = parseAttributes(match[1] ?? "");
		const context = surroundingContext(html, match.index, match[0]?.length ?? 0);
		const srcset = attrs.srcset ?? attrs["data-srcset"];
		if (srcset && !hasPreferredAnchorImage(pickBestSrcset(decodeHtmlAttr(srcset), baseUrl), context, baseUrl)) addContextual(pickBestSrcset(decodeHtmlAttr(srcset), baseUrl), "srcset", 90, attrs, context, match.index);
		for (const [key, sourceType, score] of [
			[
				"data-zoom-src",
				"data_zoom_src",
				110
			],
			[
				"data-large_image",
				"data_large_image",
				105
			],
			[
				"data-large-image",
				"data_large_image",
				105
			],
			[
				"data-original",
				"data_original",
				100
			],
			[
				"data-master",
				"data_master",
				100
			],
			[
				"data-src",
				"data_src",
				82
			],
			[
				"src",
				"img_src",
				75
			]
		]) {
			if (hasPreferredAnchorImage(attrs[key], context, baseUrl)) continue;
			addContextual(attrs[key], sourceType, score, attrs, context, match.index);
		}
	});
	collectMatches(html, /<a\b([^>]+)>([\s\S]*?)<\/a>/gi, (match) => {
		const attrs = parseAttributes(match[1] ?? "");
		const nestedImg = (match[2] ?? "").match(/<img\b([^>]+)>/i);
		if (nestedImg?.[1]) {
			const nestedAttrs = parseAttributes(nestedImg[1]);
			if (!attrs.alt && nestedAttrs.alt) attrs.alt = nestedAttrs.alt;
			if (!attrs.title && nestedAttrs.title) attrs.title = nestedAttrs.title;
			if (!attrs["aria-label"] && nestedAttrs["aria-label"]) attrs["aria-label"] = nestedAttrs["aria-label"];
		}
		const context = match[0] || surroundingContext(html, match.index, match[0]?.length ?? 0);
		addContextual(attrs.href, "anchor_href", 95, attrs, context, match.index);
	});
	collectMatches(html, /background-image\s*:\s*url\((['"]?)([^'")]+)\1\)/gi, (match) => {
		const context = surroundingContext(html, match.index, match[0]?.length ?? 0);
		addContextual(match[2], "css_background", 65, {}, context, match.index);
	});
	return dedupeCandidates(candidates);
}
function resolveDetailPageImages(candidates, opts = {}) {
	const profile = opts.profile ?? null;
	const preferredSourceOrder = profile?.preferredSourceOrder?.length ? profile.preferredSourceOrder : DEFAULT_PREFERRED_SOURCE_ORDER;
	const maxImages = profile?.maxExpectedCount ?? opts.maxImages ?? 12;
	const preferGalleryOnly = profile?.galleryOpenStrategy === "open_gallery_first" && candidates.some((candidate) => candidate.openedFromGallery);
	return uniqueImages(candidates.map((candidate) => ({
		candidate,
		labels: applyProfileLabels(candidate, profile),
		score: computeResolvedScore(candidate, profile, preferredSourceOrder)
	})).filter((item) => !shouldRejectResolvedCandidate(item.candidate, item.labels, profile)).filter((item) => !preferGalleryOnly || item.candidate.openedFromGallery).sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		return a.candidate.index - b.candidate.index;
	}).map((item) => item.candidate.url)).slice(0, maxImages);
}
function extractDetailPageImages(html, baseUrl, opts = {}) {
	return resolveDetailPageImages(collectDetailPageImageCandidates(html, baseUrl, {
		productTitle: opts.productTitle,
		productUrl: opts.productUrl,
		galleryContainerHints: opts.profile?.galleryContainerHints
	}), {
		profile: opts.profile,
		maxImages: opts.maxImages
	});
}
function normalizeImageExtractionProfile(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const input = value;
	const preferredSourceOrder = normalizeSourceOrder(input.preferredSourceOrder);
	return {
		version: 1,
		templateFingerprint: typeof input.templateFingerprint === "string" ? input.templateFingerprint.slice(0, 240) : null,
		galleryOpenStrategy: input.galleryOpenStrategy === "inline_only_fallback" ? "inline_only_fallback" : "open_gallery_first",
		galleryTriggerHints: normalizeTriggerHints(input.galleryTriggerHints),
		galleryContainerHints: normalizeStringArray$1(input.galleryContainerHints, 12),
		preferredSourceOrder: preferredSourceOrder.length > 0 ? preferredSourceOrder : DEFAULT_PREFERRED_SOURCE_ORDER,
		excludePatterns: normalizeExcludePatterns(input.excludePatterns),
		candidateLabelRules: normalizeCandidateLabelRules(input.candidateLabelRules),
		minExpectedCount: normalizePositiveInt(input.minExpectedCount),
		maxExpectedCount: normalizePositiveInt(input.maxExpectedCount)
	};
}
function normalizeSourceOrder(value) {
	const out = (Array.isArray(value) ? value : []).filter((item) => typeof item === "string").filter((item) => DEFAULT_PREFERRED_SOURCE_ORDER.includes(item));
	return [...new Set(out)];
}
function normalizeTriggerHints(value) {
	const out = (Array.isArray(value) ? value : []).filter((item) => Boolean(item && typeof item === "object" && !Array.isArray(item))).map((item) => ({
		kind: item.kind === "thumbnail" || item.kind === "zoom_button" || item.kind === "main_image" ? item.kind : "main_image",
		textHint: typeof item.textHint === "string" ? item.textHint.slice(0, 120) : void 0,
		classHint: typeof item.classHint === "string" ? item.classHint.slice(0, 120) : void 0
	})).filter((item) => item.textHint || item.classHint).slice(0, 12);
	return out.length > 0 ? out : void 0;
}
function normalizeExcludePatterns(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return void 0;
	const input = value;
	const url = normalizeStringArray$1(input.url, 16);
	const alt = normalizeStringArray$1(input.alt, 16);
	const context = normalizeStringArray$1(input.context, 16);
	if (url.length === 0 && alt.length === 0 && context.length === 0) return void 0;
	return {
		url,
		alt,
		context
	};
}
function normalizeCandidateLabelRules(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return void 0;
	const input = value;
	const out = {};
	for (const label of [
		"product_gallery",
		"supplement_facts_image",
		"ingredients_image",
		"decorative_or_lifestyle",
		"ignore"
	]) {
		const patterns = normalizeStringArray$1(input[label], 16);
		if (patterns.length > 0) out[label] = patterns;
	}
	return Object.keys(out).length > 0 ? out : void 0;
}
function normalizePositiveInt(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : void 0;
}
function normalizeStringArray$1(value, maxItems) {
	return (Array.isArray(value) ? value : typeof value === "string" ? [value] : []).filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, maxItems);
}
function dedupeCandidates(candidates) {
	const byUrl = /* @__PURE__ */ new Map();
	for (const candidate of candidates) {
		const existing = byUrl.get(candidate.url);
		if (!existing || candidate.baseScore > existing.baseScore || candidate.openedFromGallery && !existing.openedFromGallery) byUrl.set(candidate.url, candidate);
	}
	return [...byUrl.values()];
}
function computeResolvedScore(candidate, profile, preferredSourceOrder) {
	let score = candidate.baseScore;
	if (candidate.openedFromGallery) score += 40;
	const orderIndex = preferredSourceOrder.indexOf(candidate.sourceType);
	if (orderIndex >= 0) score += Math.max(0, (preferredSourceOrder.length - orderIndex) * 4);
	const labels = applyProfileLabels(candidate, profile);
	if (labels.includes("product_gallery")) score += 30;
	if (labels.includes("decorative_or_lifestyle")) score -= 18;
	if (matchesExcludePatterns(candidate, profile)) score -= 100;
	return score;
}
function shouldRejectResolvedCandidate(candidate, labels, profile) {
	if (labels.includes("ignore")) return true;
	if (labels.includes("supplement_facts_image")) return true;
	if (labels.includes("ingredients_image")) return true;
	if (matchesExcludePatterns(candidate, profile)) return true;
	return false;
}
function applyProfileLabels(candidate, profile) {
	const labels = new Set(candidate.labels);
	const rules = profile?.candidateLabelRules ?? {};
	const haystack = [
		candidate.url,
		candidate.alt ?? "",
		candidate.title ?? "",
		candidate.context
	].join(" ");
	for (const [label, patterns] of Object.entries(rules)) {
		if (!patterns?.some((pattern) => includesPattern(haystack, pattern))) continue;
		labels.add(label);
	}
	return [...labels];
}
function matchesExcludePatterns(candidate, profile) {
	const excludes = profile?.excludePatterns;
	if (!excludes) return false;
	const labels = applyProfileLabels(candidate, profile);
	return (excludes.url ?? []).some((pattern) => includesPattern(candidate.url, pattern)) || (excludes.alt ?? []).some((pattern) => includesPattern(candidate.alt ?? "", pattern)) || !labels.includes("product_gallery") && (excludes.context ?? []).some((pattern) => includesPattern(candidate.context, pattern));
}
function includesPattern(input, pattern) {
	if (!pattern) return false;
	try {
		return new RegExp(pattern, "i").test(input);
	} catch {
		return input.toLowerCase().includes(pattern.toLowerCase());
	}
}
function collectGalleryRanges(input) {
	const out = [];
	const re = /<spider-gallery-capture\b[^>]*>[\s\S]*?<\/spider-gallery-capture>/gi;
	let match;
	while ((match = re.exec(input)) !== null) out.push({
		start: match.index,
		end: match.index + match[0].length
	});
	return out;
}
function isInsideRanges(index, ranges) {
	return ranges.some((range) => index >= range.start && index < range.end);
}
function normalizeCandidate(raw, baseUrl) {
	if (!raw) return "";
	const decoded = decodeHtmlAttr(raw.trim());
	if (!decoded || decoded.startsWith("data:") || decoded.startsWith("blob:")) return "";
	try {
		return normalizeImageUrl(decoded, baseUrl);
	} catch {
		return "";
	}
}
function hasPreferredAnchorImage(raw, context, baseUrl) {
	const url = normalizeCandidate(raw, baseUrl);
	if (!url) return false;
	const anchorRe = /<a\b[^>]*\shref=["']([^"']+)["'][^>]*>/gi;
	let match;
	while ((match = anchorRe.exec(context)) !== null) {
		const href = normalizeCandidate(match[1], baseUrl);
		if (href && href !== url && !shouldRejectImage(href)) return true;
	}
	return false;
}
function parseAttributes(input) {
	const attrs = {};
	const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
	let match;
	while ((match = attrRe.exec(input)) !== null) {
		const key = match[1]?.toLowerCase();
		const value = match[2] ?? match[3] ?? match[4] ?? "";
		if (key) attrs[key] = decodeHtmlAttr(value);
	}
	return attrs;
}
function decodeHtmlAttr(value) {
	return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}
function imageUrlScore(url) {
	const lower = url.toLowerCase();
	let score = 0;
	if (/\/(?:cdn\/shop\/files|wp-content\/uploads|media\/catalog\/product|image\/cache\/catalog)\//.test(lower)) score += 25;
	if (/(?:product|products|packshot|gallery|hero|zoom|large|master|pdp|fiche|detail)/.test(lower)) score += 15;
	if (/[?&](?:width|height|w|h)=([8-9]\d{2,}|\d{4,})/.test(lower)) score += 10;
	if (/\.(?:png|jpe?g|webp)(?:[?#]|$)/.test(lower)) score += 8;
	return score;
}
function shouldRejectImage(url) {
	const lower = url.toLowerCase();
	if (!/\.(?:jpe?g|png|webp|gif)(?:[?#]|$)/.test(lower)) return true;
	return /(?:(?:^|[\/_.-])logos?(?:[\/_.-]|$)|favicon|(?:^|[\/_.-])icons?(?:[\/_.-]|$)|(?:^|\/)ico[-_.]|sprite|placeholder|payment|visa|mastercard|paypal|klarna|afterpay|social|facebook|instagram|twitter|pinterest|avatar|flag|badge|seal|star|rating|loader|spinner|cart|carrello|search|close|menu|chevron|arrow|swatch|pastille|bollini|mailstatstrk|tracking[-_.]?pixel|(?:^|[\/_.-])pixel(?:[\/_.-]|$)|beacon|tabella(?:%20|[-_ ])?(?:sf|nutriz)|nutrition[-_ ]?(?:facts?|table|label))/.test(lower);
}
/** URL-only safety gate used when rendered/pageAssets images bypass HTML context scoring. */
function isLikelyProductImageUrl(url) {
	return !shouldRejectImage(url);
}
const PRODUCT_MEDIA_CONTEXT_RE = /(?:projector_photos|photos__(?:link|photo|figure|slider|nav)|product__(?:media|image|images|photo|photos|gallery|thumbnail)|product-(?:media|image|images|photo|photos|gallery|thumbnail|slider|carousel)|product\s+(?:media|image|images|photo|photos|gallery)|product-single__media|product__photos|product__gallery|woocommerce-product-gallery|media-gallery|main-product|pdp[-_\s]?(?:media|gallery|image)|featured-image|main-image|packshot|photoswipe|image-zoom|zoom|swiper|splide|flickity|carousel|slider|gallery|lightbox|fancybox|galleria|foto-(?:grande|\d+-(?:piccola|grande))|immagine[-_\s]?prodotto)/i;
const NON_PRODUCT_CONTEXT_RE = /(?:related|recommend|recommendations|upsell|cross-sell|crosssell|collection|product-card|card-wrapper|grid__item|article|blog|instagram|newsletter|banner|footer|header|navbar|navigation|menu|payment|trust|review|testimonial|avatar|announcement|breadcrumb)/i;
const FACTS_CONTEXT_RE = /(?:supplement\s*facts?|nutrition(?:al)?\s*(?:facts?|label|table|information)|facts\s*panel|tabella\s*(?:nutrizionale|sf)|valori\s*nutrizionali|ingr[ée]dients?|ingredients?|composition)/i;
const LIFESTYLE_CONTEXT_RE = /(?:lifestyle|banner|hero|story|about|ugc|instagram|testimonial|review|ambassador|founder|benefit|icon)/i;
const STOP_TOKENS = new Set([
	"the",
	"and",
	"with",
	"for",
	"from",
	"product",
	"products",
	"complement",
	"alimentaire"
]);
function isProductMediaCandidate(url, attrs, context, productHints, galleryContainerHints) {
	const localText = [
		url,
		attrs.alt,
		attrs.title,
		attrs["aria-label"],
		attrs.class,
		attrs.id,
		attrs.itemprop
	].filter(Boolean).join(" ");
	const fullText = `${localText} ${context}`;
	const hintScore = productHintScore(localText, productHints);
	const hasProductMediaContext = PRODUCT_MEDIA_CONTEXT_RE.test(fullText) || galleryContainerHints.some((hint) => includesPattern(fullText, hint));
	if (NON_PRODUCT_CONTEXT_RE.test(fullText) && hintScore < 3) return false;
	return hasProductMediaContext || hintScore >= 2;
}
function labelCandidateHeuristically(url, attrs, context, openedFromGallery) {
	const labels = /* @__PURE__ */ new Set();
	const localHaystack = [
		url,
		attrs.alt ?? "",
		attrs.title ?? "",
		attrs["aria-label"] ?? ""
	].join(" ");
	const fullHaystack = `${localHaystack} ${context}`;
	if (FACTS_CONTEXT_RE.test(localHaystack)) labels.add("supplement_facts_image");
	if (!labels.has("supplement_facts_image") && /\bingredients?\b/i.test(localHaystack)) labels.add("ingredients_image");
	if (LIFESTYLE_CONTEXT_RE.test(fullHaystack) && !openedFromGallery) labels.add("decorative_or_lifestyle");
	if (PRODUCT_MEDIA_CONTEXT_RE.test(fullHaystack) || openedFromGallery) labels.add("product_gallery");
	if (NON_PRODUCT_CONTEXT_RE.test(fullHaystack) && !labels.has("product_gallery")) labels.add("ignore");
	return [...labels];
}
function fingerprintContainerContext(context) {
	const idMatch = context.match(/\sid=["']([^"']+)["']/i);
	if (idMatch?.[1]) return `id:${idMatch[1].slice(0, 120)}`;
	const classMatch = context.match(/\sclass=["']([^"']+)["']/i);
	if (classMatch?.[1]) return `class:${classMatch[1].split(/\s+/).filter(Boolean).slice(0, 8).join(".").slice(0, 120)}`;
	return context.replace(/\s+/g, " ").trim().slice(0, 120);
}
function surroundingContext(input, start, length) {
	const from = Math.max(0, start - 800);
	const before = input.slice(from, start);
	const blockStart = Math.max(before.lastIndexOf("<section"), before.lastIndexOf("<div"), before.lastIndexOf("<main"), before.lastIndexOf("<ul"), before.lastIndexOf("<li"), before.lastIndexOf("<figure"), before.lastIndexOf("<spider-gallery-capture"));
	const scopedBefore = blockStart >= 0 ? before.slice(blockStart) : before;
	const after = input.slice(start, Math.min(input.length, start + length + 500));
	const blockEnd = after.search(/<\/(?:section|div|main|ul|li|figure|spider-gallery-capture)>/i);
	return scopedBefore + (blockEnd >= 0 ? after.slice(0, blockEnd) : after);
}
function buildProductHints(productTitle, productUrl) {
	const rawValues = [productTitle, productSlug(productUrl)].filter((value) => Boolean(value));
	const tokenSet = /* @__PURE__ */ new Set();
	const phraseSet = /* @__PURE__ */ new Set();
	for (const rawValue of rawValues) {
		const tokens = tokenizeProductText(rawValue);
		for (const token of tokens) tokenSet.add(token);
		if (tokens.length >= 2) {
			phraseSet.add(tokens.join(" "));
			phraseSet.add(tokens.join("-"));
			phraseSet.add(tokens.join("_"));
		}
	}
	return {
		phrases: [...phraseSet],
		tokens: [...tokenSet]
	};
}
function productSlug(productUrl) {
	if (!productUrl) return "";
	try {
		const segments = new URL(productUrl).pathname.split("/").filter(Boolean);
		const productIndex = segments.findIndex((segment) => [
			"product",
			"products",
			"produs",
			"produit"
		].includes(segment));
		return segments[productIndex >= 0 ? productIndex + 1 : segments.length - 1] ?? "";
	} catch {
		return "";
	}
}
function tokenizeProductText(value) {
	return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3 && !/^\d+$/.test(token) && !STOP_TOKENS.has(token));
}
function productHintScore(input, productHints) {
	const normalized = input.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
	if (productHints.phrases.some((phrase) => normalized.includes(phrase))) return 3;
	let tokenMatches = 0;
	for (const token of productHints.tokens) if (normalized.includes(token)) tokenMatches++;
	return tokenMatches >= 2 ? 2 : tokenMatches;
}
function collectMatches(input, re, onMatch) {
	let match;
	while ((match = re.exec(input)) !== null) onMatch(match);
}

//#endregion
//#region src/pipeline/detail-dom-extract.ts
function extractDetailDomRecord(url, html, requestedFields = [], opts = {}) {
	const detailHtml = stripNonRenderedDetailBlocks(html);
	const title = extractTitle(detailHtml);
	if (isLikelySiteErrorPage(detailHtml, title)) return null;
	const images = extractDetailPageImages(detailHtml, url, {
		productTitle: title,
		productUrl: url,
		profile: opts.imageProfile
	}).filter((image) => !containsTemplatePlaceholder(image));
	const traits = extractProductTraits(detailHtml);
	const supplementFacts = buildSupplementFacts(traits, extractSupplementTables(detailHtml));
	const price = extractPrice(detailHtml);
	const currency = extractCurrency(`${price}\n${detailHtml}`);
	const fields = {
		url,
		title,
		name: title,
		description: extractDescription(detailHtml),
		images,
		price,
		currency,
		availability: extractAvailability(detailHtml)
	};
	for (const item of traits) {
		const key = canonicalTraitKey(item.label);
		if (!key || fields[key]) continue;
		fields[key] = item.value;
	}
	if (supplementFacts) {
		fields.supplement_facts = supplementFacts;
		fields.supplementFacts = supplementFacts;
	}
	const cleaned = removeEmptyFields$1(fields);
	if (Object.keys(cleaned).length <= 1 && requestedFields.length > 0) return null;
	return {
		sourceUrl: url,
		pageType: "detail",
		fields: cleaned,
		_meta: {
			layer: "detail-dom",
			source: "expanded-detail-html"
		}
	};
}
function extractTitle(html) {
	return firstText([
		/<h1\b[^>]*>([\s\S]*?)<\/h1>/i,
		/<[^>]+class=["'][^"']*(?:product_name__name|product-title|product__title|product_title|entry-title)[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i,
		/<meta\b[^>]*(?:property|name)=["']og:title["'][^>]*content=["']([^"']+)["'][^>]*>/i,
		/<title\b[^>]*>([\s\S]*?)<\/title>/i
	], html).replace(/\s+\|[\s\S]*$/, "").trim();
}
function extractDescription(html) {
	return firstText([
		/<[^>]+class=["'][^"']*(?:product_name__block[^"']*--description|projector_product__description|product_shortdescription)[^"']*["'][^>]*>([\s\S]*?)<\/(?:section|div|article)>/i,
		/<[^>]+class=["'][^"']*(?:shortdescription|product-description|product__description|longdescription|description)[^"']*["'][^>]*>([\s\S]*?)<\/(?:section|div|article)>/i,
		/<[^>]+id=["'][^"']*(?:shortdescription|description|longdescription)[^"']*["'][^>]*>([\s\S]*?)<\/(?:section|div|article)>/i,
		/<meta\b[^>]*name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i
	], html).slice(0, 2500);
}
function extractPrice(html) {
	const schemaPrices = [];
	for (const pattern of [/<meta\b[^>]*itemprop=["']price["'][^>]*content=["']([^"']+)["'][^>]*>/gi, /<meta\b[^>]*content=["']([^"']+)["'][^>]*itemprop=["']price["'][^>]*>/gi]) {
		let match;
		while ((match = pattern.exec(html)) !== null && schemaPrices.length < 20) if (match[1]) schemaPrices.push(match[1]);
	}
	for (const value of schemaPrices) {
		const price = normalizeExtractedPrice(value, { requireCurrency: false });
		if (price) return price;
	}
	const semanticSnippets = [];
	const semanticPattern = /<[^>]+(?:id|class)=["'][^"']*(?:price|prices|amount|money)[^"']*["'][^>]*>([\s\S]*?)<\/(?:strong|span|div|p|money)>/gi;
	let semanticMatch;
	while ((semanticMatch = semanticPattern.exec(html)) !== null && semanticSnippets.length < 40) if (semanticMatch[1]) semanticSnippets.push(semanticMatch[1]);
	for (const snippet of semanticSnippets) {
		const price = normalizeExtractedPrice(htmlToText(snippet), { requireCurrency: true });
		if (price) return price;
	}
	return normalizeExtractedPrice(htmlToText(html).slice(0, 16e3), { requireCurrency: true });
}
function extractCurrency(html) {
	const schemaCurrency = html.match(/<meta\b[^>]*itemprop=["']priceCurrency["'][^>]*content=["']([^"']+)["'][^>]*>/i)?.[1] ?? html.match(/<meta\b[^>]*content=["']([^"']+)["'][^>]*itemprop=["']priceCurrency["'][^>]*>/i)?.[1];
	if (schemaCurrency && /^[A-Z]{3}$/i.test(schemaCurrency)) return schemaCurrency.toUpperCase();
	const text = htmlToText(html).slice(0, 12e3);
	if (text.includes("€")) return "EUR";
	if (text.includes("$")) return "USD";
	if (text.includes("£")) return "GBP";
	if (text.includes("Kč")) return "CZK";
	if (text.includes("zł")) return "PLN";
	return text.match(/\b(EUR|USD|GBP|CZK|PLN|RON|CHF|SEK|NOK|DKK|HUF|AUD|CAD|NZD|JPY|CNY|RMB|KRW)\b/i)?.[1]?.toUpperCase() ?? "";
}
const PRICE_CURRENCY_RE = /(?:[$€£¥₹₽₩]|\b(?:EUR|USD|GBP|CZK|PLN|RON|CHF|SEK|NOK|DKK|HUF|AUD|CAD|NZD|JPY|CNY|RMB|KRW)\b|Kč|zł|\blei\b|\bFt\b)/i;
function normalizeExtractedPrice(value, opts = {}) {
	if (typeof value === "number") return Number.isFinite(value) && value > 0 ? String(value) : "";
	if (typeof value !== "string") return "";
	const valid = (value.match(/(?:[$€£¥₹₽₩]\s*)?\d{1,6}(?:(?:[ .'’]\d{3})+)?(?:[.,]\d{1,2})?\s*(?:[$€£¥₹₽₩]|EUR|USD|GBP|CZK|PLN|RON|CHF|SEK|NOK|DKK|HUF|AUD|CAD|NZD|JPY|CNY|RMB|KRW|Kč|zł|lei|Ft)?/gi) ?? []).map((candidate) => candidate.trim()).filter((candidate) => parsePriceNumber(candidate) > 0);
	const currencyBearing = valid.filter((candidate) => PRICE_CURRENCY_RE.test(candidate));
	if (opts.requireCurrency) return currencyBearing[0] ?? "";
	return currencyBearing[0] ?? valid[0] ?? "";
}
function parsePriceNumber(value) {
	let numeric = value.replace(PRICE_CURRENCY_RE, "").replace(/[^\d.,]/g, "");
	const comma = numeric.lastIndexOf(",");
	const dot = numeric.lastIndexOf(".");
	const decimalIndex = Math.max(comma, dot);
	if (decimalIndex >= 0 && numeric.length - decimalIndex - 1 <= 2) numeric = `${numeric.slice(0, decimalIndex).replace(/[.,]/g, "")}.${numeric.slice(decimalIndex + 1)}`;
	else numeric = numeric.replace(/[.,]/g, "");
	const parsed = Number(numeric);
	return Number.isFinite(parsed) ? parsed : 0;
}
const SITE_ERROR_TITLE_RE = /^(?:there was a problem loading this website|access denied|(?:404|410)(?:\s*[-–—:]\s*)?(?:page )?not found|page not found|not found|(?:500|502|503|504)(?:\s*[-–—:]\s*)?(?:internal server error|bad gateway|service unavailable|gateway timeout)?|service unavailable|temporarily unavailable|internal server error|bad gateway|gateway timeout|attention required!?|just a moment(?:\.\.\.)?|verify you are human)$/i;
const SITE_ERROR_BODY_RE = /(?:there was a problem loading this website|the requested url was not found|service unavailable|internal server error|bad gateway|gateway timeout|access denied|attention required|verify you are human)/i;
const PRODUCT_PAGE_SIGNAL_RE = /(?:itemprop=["']price|data-(?:product|price)|add[-_ ]?to[-_ ]?cart|product[-_ ]?(?:gallery|media|description))/i;
function isLikelySiteErrorPage(html, title = "") {
	const normalizedTitle = title.trim().replace(/\s+/g, " ");
	if (SITE_ERROR_TITLE_RE.test(normalizedTitle)) return true;
	const leadingText = htmlToText(html).slice(0, 4e3);
	return SITE_ERROR_BODY_RE.test(leadingText) && !PRODUCT_PAGE_SIGNAL_RE.test(html);
}
function extractAvailability(html) {
	const text = htmlToText(html).slice(0, 2e4);
	if (/\b(?:in stock|available|dostępny|add to cart)\b/i.test(text)) return "InStock";
	if (/\b(?:out of stock|sold out|unavailable)\b/i.test(text)) return "OutOfStock";
	return "";
}
function extractProductTraits(html) {
	const traits = [];
	const traitsSection = firstHtml([/<section\b[^>]*(?:id|class)=["'][^"']*(?:producttraits|traits|accordion|tabs|details)[^"']*["'][^>]*>([\s\S]*?)<\/section>/i], html) || html;
	const traitBlockRe = /<div\b[^>]*class=["'][^"']*(?:traits__item|accordion|tab-pane|collapse|product__accordion)[^"']*["'][^>]*>([\s\S]*?)(?=<div\b[^>]*class=["'][^"']*(?:traits__item|accordion|tab-pane|collapse|product__accordion)|<\/section>|$)/gi;
	let match;
	while ((match = traitBlockRe.exec(traitsSection)) !== null) {
		const block = match[1] ?? "";
		const label = firstText([/<[^>]+class=["'][^"']*(?:traits__label|accordion|label|title|heading)[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i, /<(?:button|summary|h2|h3|h4)\b[^>]*>([\s\S]*?)<\/(?:button|summary|h2|h3|h4)>/i], block);
		const value = firstText([/<[^>]+class=["'][^"']*(?:traits__values|panel|content|body|value)[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i], block) || htmlToText(block).replace(label, "").trim();
		if (label && value) traits.push({
			label,
			value
		});
	}
	const detailsRe = /<details\b[^>]*>([\s\S]*?)<\/details>/gi;
	while ((match = detailsRe.exec(html)) !== null) {
		const block = match[1] ?? "";
		const label = firstText([/<summary\b[^>]*>([\s\S]*?)<\/summary>/i], block);
		const value = htmlToText(block.replace(/<summary\b[^>]*>[\s\S]*?<\/summary>/i, " "));
		if (label && value) traits.push({
			label,
			value
		});
	}
	return dedupeTraits(traits);
}
function extractSupplementTables(html) {
	const tables = [];
	const tableRe = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
	let match;
	while ((match = tableRe.exec(html)) !== null) {
		const tableHtml = match[0] ?? "";
		const tableText = htmlToText(tableHtml);
		if (!/(?:active ingredients?|nutrition facts?|supplement facts?|nutrient|nrv|vitamin|magnesium|protein|serving)/i.test(tableText)) continue;
		const rows = [...tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) => [...(row[1] ?? "").matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => htmlToText(cell[1] ?? "")).filter(Boolean).join(" | ")).filter(Boolean);
		if (rows.length > 0) tables.push(rows.join("; "));
	}
	return tables;
}
function buildSupplementFacts(traits, tableFacts) {
	const sections = [];
	for (const table of tableFacts) sections.push(`Active ingredients: ${table}`);
	for (const trait of traits) {
		if (!/(?:recommended daily intake|directions?|suggested use|notes?|nutrition|supplement|storage)/i.test(trait.label)) continue;
		sections.push(`${trait.label}: ${trait.value}`);
	}
	return uniqueStrings$1(sections).join("\n").slice(0, 6e3);
}
function canonicalTraitKey(label) {
	const normalized = label.toLowerCase();
	if (/ingredients?/.test(normalized)) return "ingredients";
	if (/recommended daily intake|directions?|suggested use|usage/.test(normalized)) return "recommended_daily_intake";
	if (/notes?|warning|caution/.test(normalized)) return "notes";
	if (/storage/.test(normalized)) return "storage";
	if (/serving size/.test(normalized)) return "serving_size";
	return "";
}
function firstText(patterns, html) {
	for (const pattern of patterns) {
		const match = html.match(pattern);
		const value = match?.[1] ?? match?.[0];
		if (!value || containsTemplatePlaceholder(value)) continue;
		const text = htmlToText(value).trim();
		if (!text || containsTemplatePlaceholder(text)) continue;
		return text;
	}
	return "";
}
function firstHtml(patterns, html) {
	for (const pattern of patterns) {
		const match = html.match(pattern);
		const value = match?.[1] ?? match?.[0];
		if (value) return value;
	}
	return "";
}
function dedupeTraits(traits) {
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const trait of traits) {
		const label = trait.label.trim().replace(/\s+/g, " ");
		const value = trait.value.trim().replace(/\s+/g, " ");
		const key = `${label.toLowerCase()}:${value.toLowerCase()}`;
		if (containsTemplatePlaceholder(label) || containsTemplatePlaceholder(value)) continue;
		if (!label || !value || seen.has(key)) continue;
		seen.add(key);
		out.push({
			label,
			value
		});
	}
	return out;
}
function uniqueStrings$1(values) {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
function removeEmptyFields$1(fields) {
	const out = {};
	for (const [key, value] of Object.entries(fields)) {
		if (value === void 0 || value === null) continue;
		if (isHeadingOnlyDetailValue(key, value)) continue;
		if (typeof value === "string") {
			if (value.trim() === "" || containsTemplatePlaceholder(value)) continue;
			out[key] = value;
			continue;
		}
		if (Array.isArray(value)) {
			const cleaned = value.filter((item) => typeof item !== "string" || !containsTemplatePlaceholder(item));
			if (cleaned.length === 0) continue;
			out[key] = cleaned;
			continue;
		}
		out[key] = value;
	}
	return out;
}
function stripNonRenderedDetailBlocks(html) {
	return html.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<template\b[\s\S]*?<\/template>/gi, " ").replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ").replace(/<svg\b[\s\S]*?<\/svg>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
}
function containsTemplatePlaceholder(value) {
	const decoded = decodeTemplatePlaceholderValue(value);
	return /(?:\{\{|\}\}|<%|%>|\$\{)/.test(decoded);
}
function decodeTemplatePlaceholderValue(value) {
	let decoded = value.replace(/&lbrace;/gi, "{").replace(/&rbrace;/gi, "}").replace(/&#123;/g, "{").replace(/&#125;/g, "}").replace(/&lcub;/gi, "{").replace(/&rcub;/gi, "}");
	for (let i = 0; i < 2; i += 1) try {
		const next = decodeURIComponent(decoded);
		if (next === decoded) break;
		decoded = next;
	} catch {
		break;
	}
	return decoded;
}

//#endregion
//#region src/pipeline/profiles/detail-extraction/apply-profile.ts
const MAX_REGEX_LENGTH$1 = 800;
function applyDetailExtractionProfile(input) {
	const { profile, evidence } = input;
	if (isLikelySiteErrorPage(evidence.html)) return {
		record: null,
		diagnostics: {
			profileKind: "detail-extraction",
			profileVersion: profile.version,
			profileName: profile.name ?? null,
			fieldCount: 0
		}
	};
	const fields = { url: evidence.url };
	for (const field of evidence.requestedFields) {
		if (field === "url") continue;
		if (field === "images" || field === "image") {
			const images = extractProfileImages(profile, evidence.html, evidence.url, input.imageProfile ?? evidence.imageProfile);
			if (images.length > 0) fields.images = images;
			continue;
		}
		if (field === "supplement_facts" || field === "supplementFacts") {
			const facts = extractProfileFacts(profile, evidence.html, evidence.url);
			if (facts) fields.supplement_facts = facts;
			continue;
		}
		const text = firstProfileFieldText(profile, field, evidence.html);
		if (text) fields[field] = text;
	}
	const deterministic = extractDetailDomRecord(evidence.url, evidence.html, evidence.requestedFields, { imageProfile: input.imageProfile ?? evidence.imageProfile });
	if (deterministic) {
		for (const [key, value] of Object.entries(deterministic.fields)) if (isMeaningfulValue$1(value) && !isMeaningfulValue$1(fields[key])) fields[key] = value;
	}
	const title = stringField(fields.title) || stringField(fields.name);
	if (title && !fields.title) fields.title = title;
	if (title && !fields.name) fields.name = title;
	if (fields.price !== void 0) {
		const price = normalizeExtractedPrice(fields.price, { requireCurrency: false });
		if (price) fields.price = price;
		else delete fields.price;
	}
	const cleaned = removeEmptyFields(fields);
	const record = Object.keys(cleaned).length > 1 ? {
		sourceUrl: evidence.url,
		pageType: "detail",
		fields: cleaned,
		_meta: {
			layer: "detail-profile",
			profileKind: "detail-extraction",
			scriptName: profile.name ?? null
		}
	} : null;
	return {
		record,
		diagnostics: {
			profileKind: "detail-extraction",
			profileVersion: profile.version,
			profileName: profile.name ?? null,
			fieldCount: record ? Object.keys(record.fields).length : 0
		}
	};
}
function firstProfileFieldText(profile, field, html) {
	const fieldRules = profile.fieldRules?.[field] ?? [];
	for (const rule of fieldRules) {
		const text = firstRuleText(rule, html);
		if (text) return text;
	}
	return firstRegexText(profile.fieldRegexes?.[field], html);
}
function firstRuleText(rule, html) {
	if (rule.mode === "regex_text") return firstRegexText(rule.patterns, html);
	if (rule.mode === "selector_text") {
		for (const selector of rule.selectors) {
			const text = firstSelectorText(selector, html);
			if (text) return text;
		}
		return "";
	}
	return firstLabelFollowingText(rule.labelAliases, html);
}
function firstSelectorText(selector, html) {
	const trimmed = selector.trim();
	if (!trimmed || trimmed.length > 160) return "";
	if (/^[a-z][\w:-]*$/i.test(trimmed)) return firstTextFromHtml(new RegExp(`<${escapeRegex(trimmed)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeRegex(trimmed)}>`, "i"), html);
	if (trimmed.startsWith(".")) {
		const className = escapeRegex(trimmed.slice(1));
		return firstTextFromHtml(new RegExp(`<[^>]+class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, "i"), html);
	}
	if (trimmed.startsWith("#")) {
		const id = escapeRegex(trimmed.slice(1));
		return firstTextFromHtml(new RegExp(`<[^>]+id=["']${id}["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, "i"), html);
	}
	const attr = trimmed.match(/^\[([a-zA-Z0-9_:-]+)(?:=["']?([^"'\]]+)["']?)?\]$/);
	if (attr?.[1]) {
		const name = escapeRegex(attr[1]);
		const value = attr[2] ? `=["']?${escapeRegex(attr[2])}["']?` : "(?:\\s|=|>)";
		return firstTextFromHtml(new RegExp(`<[^>]+${name}${value}[^>]*>([\\s\\S]*?)<\\/[^>]+>`, "i"), html);
	}
	return "";
}
function firstTextFromHtml(pattern, html) {
	const match = html.match(pattern);
	return match?.[1] ? htmlToText(match[1]).trim() : "";
}
function firstLabelFollowingText(labels, html) {
	const text = htmlToText(html);
	const cleanLabels = labels.map((label) => label.trim()).filter(Boolean).slice(0, 20);
	if (cleanLabels.length === 0) return "";
	const stop = cleanLabels.map(escapeRegex).join("|");
	for (const label of cleanLabels) {
		const escaped = escapeRegex(label);
		const value = text.match(new RegExp(`${escaped}\\s*[:\\-]?\\s+([\\s\\S]{1,1200}?)(?=\\n?\\s*(?:${stop})\\s*[:\\-]|$)`, "i"))?.[1]?.trim();
		if (value) return value;
	}
	return "";
}
function extractProfileImages(profile, html, url, imageProfile) {
	return uniqueImages([...(profile.imageRegexes ?? []).flatMap((pattern) => allRegexTexts(pattern, html)).map((item) => normalizeImageUrl(item, url)).filter(Boolean), ...extractDetailPageImages(html, url, {
		productUrl: url,
		profile: imageProfile
	})]);
}
function extractProfileFacts(profile, html, url) {
	const facts = stringField(extractDetailDomRecord(url, html, ["supplement_facts"])?.fields.supplement_facts);
	if (facts) return facts;
	const labels = profile.factLabels?.length ? profile.factLabels : [
		"Active ingredients",
		"Supplement Facts",
		"Nutrition Facts",
		"Nutritional Information"
	];
	const text = htmlToText(html);
	return uniqueStrings(labels.map((label) => {
		const escaped = escapeRegex(label);
		const match = text.match(new RegExp(`${escaped}\\s*[:\\-]?\\s+([\\s\\S]{1,1200}?)(?=${labels.map(escapeRegex).join("|")}|$)`, "i"));
		return match?.[1] ? `${label}: ${match[1].trim()}` : "";
	}).filter(Boolean)).join("\n").slice(0, 6e3);
}
function firstRegexText(patterns, html) {
	for (const pattern of patterns ?? []) {
		const text = allRegexTexts(pattern, html)[0];
		if (text) return text;
	}
	return "";
}
function allRegexTexts(pattern, html) {
	if (!pattern || pattern.length > MAX_REGEX_LENGTH$1) return [];
	try {
		const regex = new RegExp(pattern, "gis");
		const out = [];
		let match;
		while ((match = regex.exec(html)) !== null && out.length < 20) {
			const text = htmlToText(match[1] ?? match[0]);
			if (text) out.push(text);
			if (match[0] === "") regex.lastIndex += 1;
		}
		return out;
	} catch {
		return [];
	}
}
function removeEmptyFields(fields) {
	const out = {};
	for (const [key, value] of Object.entries(fields)) {
		if (isHeadingOnlyDetailValue(key, value)) continue;
		if (!isMeaningfulValue$1(value)) continue;
		out[key] = value;
	}
	return out;
}

// A profile can accidentally capture an accordion/tab heading instead of the
// content revealed below it (for example, the literal string "Ingredients").
// Treat those heading-only values as missing so the detail route is forced down
// its rendered/visual fallback instead of accepting a false-positive field.
const DETAIL_HEADING_ONLY_RE = {
	ingredients: /^(?:ingredients?|ingredient\s+list|view\s+ingredients?|show\s+ingredients?)\s*[:\-–—]?$/i,
	supplement_facts: /^(?:supplement\s+facts?|nutrition(?:al)?\s+facts?|nutrition(?:al)?\s+information|facts?|ingredients?)\s*[:\-–—]?$/i,
};

function isHeadingOnlyDetailValue(field, value) {
	const normalizedField = String(field ?? "")
		.replace(/([a-z])([A-Z])/g, "$1_$2")
		.toLowerCase();
	const kind = normalizedField.includes("supplement")
		|| normalizedField.includes("nutrition")
		|| normalizedField === "facts"
		? "supplement_facts"
		: normalizedField.includes("ingredient")
			? "ingredients"
			: "";
	const pattern = DETAIL_HEADING_ONLY_RE[kind];
	if (!pattern) return false;
	const values = Array.isArray(value) ? value : [value];
	if (values.length === 0) return true;
	return values.every((item) => {
		if (typeof item !== "string") return false;
		const text = htmlToText(item).replace(/\s+/g, " ").trim();
		return pattern.test(text);
	});
}
function isMeaningfulValue$1(value) {
	if (value === null || value === void 0) return false;
	if (typeof value === "string") return value.trim() !== "";
	if (Array.isArray(value)) return value.length > 0;
	return true;
}
function stringField(value) {
	return typeof value === "string" ? value.trim() : "";
}
function uniqueStrings(values) {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
function escapeRegex(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

//#endregion
//#region src/pipeline/profiles/detail-extraction/field-aliases.ts
const DETAIL_FIELD_ALIASES = {
	title: [
		"title",
		"name",
		"productName",
		"productTitle",
		"product_name"
	],
	url: [
		"url",
		"productUrl",
		"href",
		"permalink",
		"link"
	],
	price: [
		"price",
		"currentPrice",
		"salePrice",
		"regularPrice",
		"amount"
	],
	description: [
		"description",
		"desc",
		"details",
		"productDescription",
		"summary",
		"shortDescription",
		"longDescription"
	],
	images: [
		"images",
		"image",
		"photos",
		"photoUrls",
		"gallery",
		"media"
	],
	brand: [
		"brand",
		"manufacturer",
		"brandName",
		"vendor"
	],
	sku: [
		"sku",
		"productCode",
		"itemCode",
		"modelNumber",
		"id"
	],
	availability: [
		"availability",
		"inStock",
		"stockStatus",
		"stock"
	],
	category: [
		"category",
		"categories",
		"productType",
		"type",
		"tags"
	],
	supplement_facts: [
		"supplement_facts",
		"supplementFacts",
		"nutrition_facts",
		"nutritionFacts",
		"nutritionalInformation",
		"nutritional_information"
	],
	ingredients: [
		"ingredients",
		"ingredient_list",
		"ingredientList"
	],
	serving_size: ["serving_size", "servingSize"],
	recommended_daily_intake: [
		"recommended_daily_intake",
		"directions",
		"suggested_use",
		"usage"
	]
};

//#endregion
//#region src/pipeline/profiles/detail-extraction/normalize-profile.ts
const MAX_REGEX_LENGTH = 800;
const MAX_RULES_PER_FIELD = 8;
function normalizeDetailExtractionProfile(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const input = value;
	const fieldRegexes = {};
	const rawFields = input.fieldRegexes;
	if (rawFields && typeof rawFields === "object" && !Array.isArray(rawFields)) for (const [field, patterns] of Object.entries(rawFields)) {
		const cleaned = normalizeRegexArray(patterns);
		if (cleaned.length > 0) fieldRegexes[field] = cleaned;
	}
	return {
		kind: "detail-extraction",
		version: 1,
		name: typeof input.name === "string" ? input.name.slice(0, 120) : void 0,
		notes: typeof input.notes === "string" ? input.notes.slice(0, 500) : void 0,
		fieldRules: normalizeFieldRules(input.fieldRules),
		fieldRegexes,
		imageRegexes: normalizeRegexArray(input.imageRegexes),
		factLabels: normalizeStringArray(input.factLabels),
		tableKeywords: normalizeStringArray(input.tableKeywords),
		fieldPolicy: normalizeFieldPolicy(input.fieldPolicy),
		interactionHints: normalizeInteractionHints(input.interactionHints)
	};
}
function normalizeFieldRules(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return void 0;
	const out = {};
	for (const [field, rawRules] of Object.entries(value)) {
		const rules = (Array.isArray(rawRules) ? rawRules : [rawRules]).map(normalizeFieldRule).filter((rule) => Boolean(rule)).slice(0, MAX_RULES_PER_FIELD);
		if (rules.length > 0) out[field] = rules;
	}
	return Object.keys(out).length > 0 ? out : void 0;
}
function normalizeFieldRule(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const item = value;
	if (item.mode === "regex_text") {
		const patterns = normalizeRegexArray(item.patterns);
		return patterns.length > 0 ? {
			mode: "regex_text",
			patterns
		} : null;
	}
	if (item.mode === "selector_text") {
		const selectors = normalizeRawStringArray(item.selectors).slice(0, MAX_RULES_PER_FIELD);
		return selectors.length > 0 ? {
			mode: "selector_text",
			selectors
		} : null;
	}
	if (item.mode === "label_following_text") {
		const labelAliases = normalizeStringArray(item.labelAliases).slice(0, MAX_RULES_PER_FIELD);
		return labelAliases.length > 0 ? {
			mode: "label_following_text",
			labelAliases
		} : null;
	}
	return null;
}
function normalizeFieldPolicy(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return void 0;
	const out = {};
	for (const [field, raw] of Object.entries(value)) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const item = raw;
		const availability = item.availability === "present_visible" || item.availability === "present_hidden" || item.availability === "not_present" ? item.availability : "uncertain";
		out[field] = {
			availability,
			missingBehavior: item.missingBehavior === "allow_missing" || item.missingBehavior === "require_fallback" ? item.missingBehavior : availability === "not_present" ? "allow_missing" : "require_fallback",
			evidence: normalizeStringArray(item.evidence).slice(0, 8),
			reason: typeof item.reason === "string" ? item.reason.slice(0, 500) : void 0,
			interactionHints: normalizeInteractionHints(item.interactionHints)
		};
	}
	return Object.keys(out).length > 0 ? out : void 0;
}
function normalizeInteractionHints(value) {
	const hints = (Array.isArray(value) ? value : []).filter((item) => Boolean(item && typeof item === "object" && !Array.isArray(item))).map((item) => {
		const action = item.action === "open_details" || item.action === "scroll" ? item.action : "click";
		return {
			field: typeof item.field === "string" ? item.field.slice(0, 80) : void 0,
			action,
			labelPattern: typeof item.labelPattern === "string" ? item.labelPattern.slice(0, 160) : void 0,
			selectorHint: typeof item.selectorHint === "string" ? item.selectorHint.slice(0, 160) : void 0,
			reason: typeof item.reason === "string" ? item.reason.slice(0, 240) : void 0
		};
	}).filter((item) => item.field || item.labelPattern || item.selectorHint).slice(0, 12);
	return hints.length > 0 ? hints : void 0;
}
function normalizeRegexArray(value) {
	return (Array.isArray(value) ? value : typeof value === "string" ? [value] : []).filter((item) => typeof item === "string").map((item) => item.trim()).filter((item) => item.length > 0 && item.length <= MAX_REGEX_LENGTH).slice(0, MAX_RULES_PER_FIELD);
}
function normalizeStringArray(value) {
	return normalizeRawStringArray(value).map((item) => htmlToText(item).trim()).filter(Boolean).slice(0, 20);
}
function normalizeRawStringArray(value) {
	return (Array.isArray(value) ? value : typeof value === "string" ? [value] : []).filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

//#endregion
//#region src/pipeline/profiles/detail-extraction/validate-profile.ts
function validateDetailExtractionProfile(profile, result, evidence) {
	const record = isApplyResult(result) ? result.record : result ?? null;
	const missingFields = missingDetailExtractionFields(record, evidence.requestedFields);
	const split = splitMissingDetailExtractionFieldsByPolicy(missingFields, profile);
	const basicRecordPresent = hasBasicProductIdentity(record);
	const accepted = basicRecordPresent && split.requiredMissingFields.length === 0;
	return {
		status: accepted ? missingFields.length === 0 ? "valid" : "partial" : basicRecordPresent ? "partial" : "invalid",
		accepted,
		basicRecordPresent,
		missingFields,
		ignoredMissingFields: split.ignoredMissingFields,
		requiredMissingFields: split.requiredMissingFields,
		reason: accepted ? missingFields.length === 0 ? "all_requested_fields_present" : "only_allow_missing_fields_absent" : basicRecordPresent ? "required_fields_missing" : "basic_product_identity_missing"
	};
}
function missingDetailExtractionFields(record, requestedFields) {
	if (!record) return requestedFields;
	return requestedFields.filter((field) => !hasRequestedDetailField(record.fields, field));
}
function splitMissingDetailExtractionFieldsByPolicy(missingFields, profile) {
	const ignoredMissingFields = missingFields.filter((field) => profile?.fieldPolicy?.[field]?.missingBehavior === "allow_missing");
	return {
		ignoredMissingFields,
		requiredMissingFields: missingFields.filter((field) => !ignoredMissingFields.includes(field))
	};
}
function hasRequestedDetailField(fields, requestedField) {
	const aliases = DETAIL_FIELD_ALIASES[requestedField] ?? [requestedField];
	if (requestedField === "price") return aliases.some((alias) => normalizeExtractedPrice(fields[alias], { requireCurrency: false }) !== "");
	return aliases.some((alias) => isMeaningfulValue(fields[alias])
		&& !isHeadingOnlyDetailValue(requestedField, fields[alias]));
}
function isApplyResult(value) {
	return Boolean(value && typeof value === "object" && "record" in value);
}
function hasBasicProductIdentity(record) {
	if (!record) return false;
	const title = stringValue(record.fields.title) || stringValue(record.fields.name);
	const images = Array.isArray(record.fields.images) ? record.fields.images : [];
	return isHttpUrl(stringValue(record.fields.url) || record.sourceUrl) && (title !== "" || images.length > 0);
}
function isMeaningfulValue(value) {
	if (value === null || value === void 0) return false;
	if (typeof value === "string") return value.trim() !== "";
	if (Array.isArray(value)) return value.length > 0;
	return true;
}
function stringValue(value) {
	return typeof value === "string" ? value.trim() : "";
}
function isHttpUrl(value) {
	try {
		const parsed = new URL(value);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

//#endregion
export { DETAIL_FIELD_ALIASES, ORIGINAL_IMAGE_RESOLVER_KINDS, PAGINATION_MORE_TEXT_PATTERN, PAGINATION_NEXT_TEXT_PATTERN, applyDetailExtractionProfile, cleanHtml, collectDetailPageImageCandidates, collectDetailUrls, collectLocalCategoryEntries, collectStoreRootCandidates, deriveOriginalImageCandidate, enumerateShopifyProducts, extractCategoryEntries, extractDetailDomRecord, extractDetailPageImages, extractFooterEntryCandidates, extractLinks, extractListingBodyHtml, extractMenuEntryCandidates, extractSupplementFactsFromHtml, findNextListingPage, hasRequestedDetailField, htmlToText, imageIdentityKey, isHeadingOnlyDetailValue, isLikelyProductImageUrl, isLikelySiteErrorPage, isSameSite, looksLikeCategoryUrl, looksLikeProductUrl, mergeStrings, missingDetailExtractionFields, nominateEntriesFromSitemap, normalizeDetailExtractionProfile, normalizeExtractedPrice, normalizeFieldPolicy, normalizeImageExtractionProfile, normalizeImageUrl, normalizeInteractionHints, normalizeProductUrl, normalizeUrl, pickBestSrcset, registrableDomain, resolveDetailPageImages, shouldRejectUrl, splitMissingDetailExtractionFieldsByPolicy, stripJsonLd, stripWpThumbSuffix, uniqueImages, validateDetailExtractionProfile, visibleLinkText };
