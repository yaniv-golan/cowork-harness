// A synthetic agent bundle for the web-search anchor tests. The prose is invented; only the code SHAPE mirrors the
// agent's.
import { SEARCH_ANCHOR_CALL_SITE } from "../../src/sync/search-anchors.js";

// The prose is invented here; only the code SHAPE mirrors the agent's nested-search call
// site (one user message built from a prefix literal plus the query, one system-prompt literal, the server tool
// type, and the querySource marker), and the CCR worker route.
export const PREFIX = "Look this up on the web please: ";
export const SENTENCE = "You are a pretend assistant that searches.";
export const callSite = (prefix = PREFIX, sentence = SENTENCE) =>
  `let v=xe({content:"${prefix}"+h}),R={type:"web_search_20250305",name:"web_search",max_uses:8},` +
  `H=Qwt({messages:[v],systemPrompt:ki(["${sentence}"]),thinkingConfig:{type:"disabled"},tools:[],` +
  `options:{toolChoice:{type:"tool",name:"web_search"},extraToolSchemas:[R],${SEARCH_ANCHOR_CALL_SITE},enablePromptCaching:!1}})`;
export const ccr =
  'he=Y?.replace(/\\/+$/,"")??`${q}/v1/code/sessions/${encodeURIComponent(INe(e))}`;be=await Rt.post(`${he}/worker/${n}`,y);' +
  'let Q=await ko(f.session,h,n),r="web-search"';
// The no-request templates sit in the same tool definition, before the nested-search call site: two fixed
// validateInput messages and the budget-cap template (fixed P1, the turn|session variable, fixed P2, then variables).
// Constructed from the shape at the 2.1.295 offsets; the prose is invented.
export const MISSING = "Error: nothing to look up";
export const BOTH = "Error: pick one list of domains, not both";
export const P1 = "Search skipped: this ";
export const P2 = " has spent its search allowance (";
export const noRequestSite = (o: { missing?: string; both?: string; p1?: string; p2?: string; scope?: string } = {}) =>
  `async validateInput(r){let{query:n,allowed_domains:s,blocked_domains:f}=r;if(!n.length)return{result:!1,message:"${o.missing ?? MISSING}",errorCode:1};` +
  `if(s?.length&&f?.length)return{result:!1,message:"${o.both ?? BOTH}",errorCode:2};return{result:!0}},` +
  `async call(r){let w=f.taskRegistry.getWebSearchBudget();if(!w.tryConsume()){let te=ve()${o.scope ?? '?"turn":"session"'},dn=1;` +
  "return{data:{query:h,results:[`" +
  (o.p1 ?? P1) +
  "${te}" +
  (o.p2 ?? P2) +
  "${dn}). more ${mn}`]}}}}";
// The string table holds a second copy of literals, far from the call site.
export const stringTable = `\0web_search_20250305\0${PREFIX}\0${SENTENCE}\0`;
export const pad = (n: number) => "x".repeat(n);
// The tool runner's schema-failure result (shared by every tool), far from the WebSearch tool: a ZOD_VALIDATION
// telemetry marker, then the result whose fixed prefix is anchored. Invented text, the runner's shape.
export const IVE = "Bad tool input here: ";
export const zodSite = (o: { prefix?: string; marker?: string } = {}) =>
  `i("tengu_tool_use_error",{error:b("X"),errorCode:b("${o.marker ?? "ZOD_VALIDATION"}")});` +
  'return[{message:xe({content:[{type:"tool_result",content:`<tool_use_error>' +
  (o.prefix ?? IVE) +
  "${Eo}</tool_use_error>`,is_error:!0}]})}]";
export const bundle = (site = callSite(), nr = noRequestSite(), zod = zodSite()) =>
  Buffer.from(stringTable + zod + pad(20000) + ccr + pad(9000) + nr + pad(1200) + site + pad(500));
