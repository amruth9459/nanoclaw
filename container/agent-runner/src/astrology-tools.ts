/**
 * Jyotish MCP tools — container-side wrapper.
 *
 * Registers jyotish_calculate, jyotish_compatibility, and jyotish_interpret tools.
 * Communicates with the host-side Jyotish engine via IPC (write JSON → poll response).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

interface ToolContext {
  groupFolder: string;
  chatJid: string;
  writeIpcFile: (dir: string, data: object) => string;
  pollResponse: (responseFile: string, timeoutMs: number) => Promise<Record<string, unknown> | null>;
  MESSAGES_DIR: string;
}

export function registerTools(server: McpServer, ctx: ToolContext): void {
  const IPC_DIR = '/workspace/ipc';

  server.tool(
    'jyotish_calculate',
    `Calculate a Vedic astrology (Jyotish) chart. Uses Swiss Ephemeris with Lahiri ayanamsa (matching Jagannatha Hora).
Always returns: D-1 (Rasi), D-9 (Navamsa), D-10 (Dasamsa), Vimshottari Dasha, Shadbala, Bhava Bala.
Use the 'analyses' parameter to request additional computations:
- yogas: 100+ classical yogas (Vesi, Vosi, Gajakesari, etc.)
- raja_yogas: Power/authority yogas (Dharma-Karmadhipati, Neecha Bhanga, etc.)
- doshas: Manglik, Kala Sarpa, Guru Chandala, Pitru, Shrapit, etc.
- ashtakavarga: Full BAV (per-planet) + SAV (total) bindus per house
- arudhas: Bhava Arudhas A1-A12 + Graha Arudhas
- sphutas: 12 sensitive points (Prana, Deha, Mrityu, Beeja, Kshetra, Yogi, etc.)
- special_lagnas: Sree, Indu, Bhrigu Bindhu, Hora, Ghati, Varnada, etc.
- karakas: Chara Karakas (Jaimini) — AK through PiK
- vimsopaka: 20-point divisional strength (Shadvarga/Sapthavarga/Shodasavarga)
- panchanga: Tithi, Nakshatra, Yoga, Karana, Vaara, Sunrise/Sunset
- all_dashas: 50 dasha systems — 22 Graha (Vimshottari, Ashtottari, Yogini, Moola, Naisargika, Buddhi Gathi, Dwadasottari, Chathuraaseethi Sama, Panchottari, Shodasottari, Sataatbika, Dwisatpathi, Kaala, Karaka, Rashmi, Tara, Saptharishi, Shastihayani, Shattrimsa, Tithi Ashtottari, Tithi Yogini, Yoga Vimsottari) + 24 Raasi (Narayana, Chara, Sthira, Kalachakra, Shoola, Sudasa, Drig, Trikona, Brahma, Chakra, Niryaana, Raashiyanka, Varnada, Yogardha, Mandooka, Paryaaya, Sandhya, Tara Lagna, Lagnamsaka, Navamsa, Padhanadhamsa, Chathurvidha Utthara, Lagna Kendraadhi, Karaka Kendraadhi) + 3 Annual (Mudda, Varsha Vimsottari, Patyayini)
- sahams: 36 Sahams (Arabic Parts) — Punya, Vidya, Vivaha, Rajya, Karma, Roga, Mrithyu, etc.
- tajaka: Annual chart (Varshaphal) + Year Lord
- all: Everything above`,
    {
      year: z.number().int().describe('Birth year (e.g., 1990)'),
      month: z.number().int().min(1).max(12).describe('Birth month (1-12)'),
      day: z.number().int().min(1).max(31).describe('Birth day (1-31)'),
      hour: z.number().int().min(0).max(23).describe('Birth hour (0-23, 24-hour format)'),
      minute: z.number().int().min(0).max(59).describe('Birth minute (0-59)'),
      second: z.number().int().min(0).max(59).default(0).describe('Birth second (default: 0)'),
      place_name: z.string().describe('Birth place name (e.g., "Mumbai")'),
      latitude: z.number().describe('Latitude of birth place (e.g., 19.0760)'),
      longitude: z.number().describe('Longitude of birth place (e.g., 72.8777)'),
      timezone_offset: z.number().describe('Timezone offset in hours (e.g., 5.5 for IST)'),
      ayanamsa: z.string().default('LAHIRI').describe('Ayanamsa mode (default: LAHIRI). Options: LAHIRI, TRUE_CITRA, KP, RAMAN'),
      divisional_charts: z.array(z.number().int()).optional().describe('Divisional chart factors (default: [9, 10]). Full Shodasavarga: [2,3,4,7,9,10,12,16,20,24,27,30,40,45,60]'),
      analyses: z.array(z.string()).optional().describe('Extra analyses to compute. Options: yogas, raja_yogas, doshas, ashtakavarga, arudhas, sphutas, special_lagnas, karakas, vimsopaka, panchanga, all_dashas, sahams, tajaka, all'),
    },
    async (args) => {
      const requestId = `jyotish-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const requestFile = path.join(IPC_DIR, `${requestId}.jyotish.json`);
      const responseFile = path.join(IPC_DIR, `${requestId}.result.json`);

      const request = {
        type: 'jyotish_calculate',
        requestId,
        ...args,
        responseFile,
      };

      const tmp = `${requestFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(request, null, 2));
      fs.renameSync(tmp, requestFile);

      // Poll for response (longer timeout for full analysis)
      const hasAnalyses = args.analyses && args.analyses.length > 0;
      const timeout = Date.now() + (hasAnalyses ? 60000 : 35000);
      while (Date.now() < timeout) {
        await new Promise(r => setTimeout(r, 300));
        if (fs.existsSync(responseFile)) {
          try {
            const result = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
            fs.unlinkSync(responseFile);
            if (result.error) {
              return { content: [{ type: 'text' as const, text: `Jyotish error: ${result.error}` }], isError: true };
            }

            // Format chart output
            const rasi = (result.rasi || []).map((p: { body: string; rashi: string; deg: number; min: number; nakshatra: string; pada: number }) =>
              `${p.body}: ${p.rashi} ${p.deg}°${String(p.min).padStart(2, '0')}' [${p.nakshatra} P${p.pada}]`
            ).join('\n');

            const dasha = (result.vimshottari || [])
              .filter((d: { level: string }) => d.level === 'maha')
              .map((d: { lord: string; start_date: string; years: number }) =>
                `${d.lord}: ${d.start_date} (${d.years} yrs)`
              ).join('\n');

            // Build sections dynamically
            const sections: string[] = [
              `VEDIC CHART — ${result.place_name} | ${result.birth_date} ${result.birth_time}`,
              `Ayanamsa: ${result.ayanamsa}`,
              `\nRASI (D-1):\n${rasi}`,
              `\nVIMSHOTTARI MAHADASHA:\n${dasha}`,
            ];

            if (result.ashtakavarga_sav?.length) {
              sections.push(`\nSARVASHTAKAVARGA (SAV): ${JSON.stringify(result.ashtakavarga_sav)}`);
            }
            if (result.yogas?.length) {
              sections.push(`\nYOGAS (${result.yogas.length} found)`);
            }
            if (result.raja_yogas?.length) {
              sections.push(`RAJA YOGAS (${result.raja_yogas.length} found)`);
            }
            if (result.doshas && Object.keys(result.doshas).length) {
              sections.push(`DOSHAS: ${Object.keys(result.doshas).join(', ')}`);
            }
            if (result.chara_karakas && Object.keys(result.chara_karakas).length) {
              const ck = Object.entries(result.chara_karakas).map(([k, v]) => `${k}=${v}`).join(', ');
              sections.push(`\nCHARA KARAKAS: ${ck}`);
            }
            if (result.other_dashas && Object.keys(result.other_dashas).length) {
              sections.push(`\nDASHA SYSTEMS (${Object.keys(result.other_dashas).length}): ${Object.keys(result.other_dashas).join(', ')}`);
            }
            if (result.sahams && Object.keys(result.sahams).length) {
              sections.push(`\nSAHAMS (${Object.keys(result.sahams).length} computed)`);
            }
            if (result.tajaka && Object.keys(result.tajaka).length) {
              const tj = result.tajaka;
              sections.push(`\nTAJAKA: Year Lord=${tj.year_lord || '?'}, Annual Chart=${tj.annual_chart?.length || 0} planets`);
            }

            return {
              content: [
                { type: 'text' as const, text: sections.join('\n') },
                { type: 'text' as const, text: `\n\nFull data:\n${JSON.stringify(result, null, 2).slice(0, 30000)}` },
              ],
            };
          } catch {
            return { content: [{ type: 'text' as const, text: 'Failed to parse jyotish results.' }], isError: true };
          }
        }
      }
      return { content: [{ type: 'text' as const, text: 'Jyotish calculation timed out.' }], isError: true };
    },
  );

  server.tool(
    'jyotish_compatibility',
    `Calculate marriage compatibility (Ashtakoota / Koota Milan) between two birth charts.
Returns 8 main Kootas (Varna, Vasiya, Tara, Yoni, Maitri, Gana, Bahut/Bhakut, Naadi) plus supplementary checks (Rajju, Vedha, Dina, Stree Dheerga, Mahendra).
Total score out of 36 (North Indian method). Score >= 18 is considered acceptable for marriage.`,
    {
      boy_year: z.number().int().describe('Boy birth year'),
      boy_month: z.number().int().min(1).max(12).describe('Boy birth month'),
      boy_day: z.number().int().min(1).max(31).describe('Boy birth day'),
      boy_hour: z.number().int().min(0).max(23).describe('Boy birth hour (24h)'),
      boy_minute: z.number().int().min(0).max(59).describe('Boy birth minute'),
      boy_second: z.number().int().min(0).max(59).default(0),
      boy_place_name: z.string().describe('Boy birth place'),
      boy_latitude: z.number().describe('Boy birth latitude'),
      boy_longitude: z.number().describe('Boy birth longitude'),
      boy_timezone: z.number().describe('Boy timezone offset (hours)'),
      girl_year: z.number().int().describe('Girl birth year'),
      girl_month: z.number().int().min(1).max(12).describe('Girl birth month'),
      girl_day: z.number().int().min(1).max(31).describe('Girl birth day'),
      girl_hour: z.number().int().min(0).max(23).describe('Girl birth hour (24h)'),
      girl_minute: z.number().int().min(0).max(59).describe('Girl birth minute'),
      girl_second: z.number().int().min(0).max(59).default(0),
      girl_place_name: z.string().describe('Girl birth place'),
      girl_latitude: z.number().describe('Girl birth latitude'),
      girl_longitude: z.number().describe('Girl birth longitude'),
      girl_timezone: z.number().describe('Girl timezone offset (hours)'),
      method: z.string().default('North').describe('Method: North (Ashtakoota, 36 max) or South (Dashakoota)'),
    },
    async (args) => {
      const requestId = `jyotish-compat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const requestFile = path.join(IPC_DIR, `${requestId}.jyotish.json`);
      const responseFile = path.join(IPC_DIR, `${requestId}.result.json`);

      const request = {
        type: 'compatibility',
        requestId,
        ...args,
        responseFile,
      };

      const tmp = `${requestFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(request, null, 2));
      fs.renameSync(tmp, requestFile);

      const timeout = Date.now() + 35000;
      while (Date.now() < timeout) {
        await new Promise(r => setTimeout(r, 300));
        if (fs.existsSync(responseFile)) {
          try {
            const result = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
            fs.unlinkSync(responseFile);
            if (result.error) {
              return { content: [{ type: 'text' as const, text: `Compatibility error: ${result.error}` }], isError: true };
            }

            const kootas = result.kootas || {};
            const lines = Object.entries(kootas).map(([k, v]: [string, any]) => {
              if (v.max !== undefined && v.max !== null) return `${k}: ${v.score}/${v.max}`;
              if (v.match !== undefined) return `${k}: ${v.match ? 'Yes' : 'No'}`;
              return `${k}: ${v.score ?? v.result ?? 'N/A'}`;
            }).join('\n');

            const text = [
              `MARRIAGE COMPATIBILITY (${result.method} method)`,
              `Boy: ${result.boy.nakshatra} Pada ${result.boy.pada}`,
              `Girl: ${result.girl.nakshatra} Pada ${result.girl.pada}`,
              `\nTOTAL SCORE: ${result.total_score}/${result.max_score}`,
              result.total_score >= 18 ? 'Verdict: ACCEPTABLE for marriage' :
                result.total_score >= 12 ? 'Verdict: MARGINAL — remedies recommended' :
                'Verdict: NOT RECOMMENDED without strong remedies',
              `\nKOOTA BREAKDOWN:\n${lines}`,
            ].join('\n');

            return { content: [
              { type: 'text' as const, text },
              { type: 'text' as const, text: `\n\nFull data:\n${JSON.stringify(result, null, 2)}` },
            ]};
          } catch {
            return { content: [{ type: 'text' as const, text: 'Failed to parse compatibility results.' }], isError: true };
          }
        }
      }
      return { content: [{ type: 'text' as const, text: 'Compatibility calculation timed out.' }], isError: true };
    },
  );

  server.tool(
    'jyotish_interpret',
    `Interpret a Vedic astrology chart using the 7-stage PVR pipeline. Computes chart + runs interpretation.
Returns structured predictions for career, marriage, wealth, health with confidence levels.
Stages: 1) Chart verification, 2) Strength assessment, 3) Navamsha cross-check,
4) Karaka identification, 5) Dasha analysis, 6) Transit layer, 7) Synthesis.
Use this instead of jyotish_calculate when you want interpreted results, not raw chart data.`,
    {
      year: z.number().int().describe('Birth year'),
      month: z.number().int().min(1).max(12).describe('Birth month'),
      day: z.number().int().min(1).max(31).describe('Birth day'),
      hour: z.number().int().min(0).max(23).describe('Birth hour (24h)'),
      minute: z.number().int().min(0).max(59).describe('Birth minute'),
      second: z.number().int().min(0).max(59).default(0),
      place_name: z.string().describe('Birth place name'),
      latitude: z.number().describe('Latitude'),
      longitude: z.number().describe('Longitude'),
      timezone_offset: z.number().describe('Timezone offset (hours)'),
    },
    async (args) => {
      const requestId = `jyotish-interp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const requestFile = path.join(IPC_DIR, `${requestId}.jyotish.json`);
      const responseFile = path.join(IPC_DIR, `${requestId}.result.json`);

      const request = {
        type: 'interpret',
        requestId,
        ...args,
        analyses: ['yogas', 'raja_yogas', 'doshas', 'ashtakavarga', 'karakas', 'panchanga', 'all_dashas', 'sahams'],
        responseFile,
      };

      const tmp = `${requestFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(request, null, 2));
      fs.renameSync(tmp, requestFile);

      const timeout = Date.now() + 90000; // 90s for full interpretation
      while (Date.now() < timeout) {
        await new Promise(r => setTimeout(r, 500));
        if (fs.existsSync(responseFile)) {
          try {
            const result = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
            fs.unlinkSync(responseFile);
            if (result.error) {
              return { content: [{ type: 'text' as const, text: `Interpretation error: ${result.error}` }], isError: true };
            }

            const summary = result.chart_summary || {};
            const predictions = result.predictions || [];

            const lines = [
              `JYOTISH INTERPRETATION — ${args.place_name} | ${args.year}-${String(args.month).padStart(2, '0')}-${String(args.day).padStart(2, '0')}`,
              `Lagna: ${summary.lagna || '?'}`,
              `Strong: ${(summary.strong_planets || []).join(', ')}`,
              `Weak: ${(summary.weak_planets || []).join(', ')}`,
              `Vargottama: ${(summary.vargottama || []).join(', ') || 'None'}`,
              `\nPREDICTIONS (${predictions.length}):`,
              ...predictions.map((p: any) => `[${(p.confidence * 100).toFixed(0)}%] ${p.area}: ${p.summary}`),
              `\nYogas: ${result.yogas?.count || 0} | Raja Yogas: ${result.yogas?.raja_yoga_count || 0}`,
              `Overall Confidence: ${((result.overall_confidence || 0) * 100).toFixed(0)}%`,
              `Methodology: ${result.methodology || 'PVR 7-Stage'}`,
            ];

            return { content: [
              { type: 'text' as const, text: lines.join('\n') },
              { type: 'text' as const, text: `\n\nFull interpretation:\n${JSON.stringify(result, null, 2).slice(0, 30000)}` },
            ]};
          } catch {
            return { content: [{ type: 'text' as const, text: 'Failed to parse interpretation results.' }], isError: true };
          }
        }
      }
      return { content: [{ type: 'text' as const, text: 'Interpretation timed out.' }], isError: true };
    },
  );
}
