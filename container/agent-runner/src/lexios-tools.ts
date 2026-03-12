/**
 * Lexios MCP tools — registered conditionally for Lexios-owned groups only.
 * Extracted from ipc-mcp-stdio.ts to keep the core agent runner generic.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

interface LexiosToolsContext {
  groupFolder: string;
  chatJid: string;
  writeIpcFile: (dir: string, data: object) => string;
  pollResponse: (responseFile: string, timeoutMs: number) => Promise<Record<string, unknown> | null>;
  MESSAGES_DIR: string;
}

function writeLexiosRequest(ctx: LexiosToolsContext, data: object): { responseFile: string } {
  const requestId = `lexios-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const requestFile = path.join(ctx.MESSAGES_DIR, `${requestId}.json`);
  const responseFile = path.join(ctx.MESSAGES_DIR, `${requestId}.response.json`);

  const payload = { ...data, requestId, responseFile, groupFolder: ctx.groupFolder, chatJid: ctx.chatJid, timestamp: new Date().toISOString() };
  const tmp = `${requestFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, requestFile);

  return { responseFile };
}

function writeJurisdictionRequest(ctx: LexiosToolsContext, data: object): { responseFile: string } {
  const requestId = `jurisdiction-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const requestFile = path.join(ctx.MESSAGES_DIR, `${requestId}.json`);
  const responseFile = path.join(ctx.MESSAGES_DIR, `${requestId}.response.json`);

  const payload = { ...data, requestId, responseFile, groupFolder: ctx.groupFolder, chatJid: ctx.chatJid, timestamp: new Date().toISOString() };
  const tmp = `${requestFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, requestFile);

  return { responseFile };
}

/** Standard export name used by the integration tool loader in ipc-mcp-stdio.ts */
export const registerTools = registerLexiosTools;

export function registerLexiosTools(server: McpServer, ctx: LexiosToolsContext): void {
  // ── Lexios customer tracking ──────────────────────────────────────────

  server.tool(
    'lexios_report_analysis',
    'Report a completed document analysis to track customer usage. Call this after finishing a Lexios document analysis.',
    {
      pages: z.number().int().min(1).describe('Number of pages analyzed'),
    },
    async (args) => {
      if (!ctx.groupFolder.startsWith('lexios-')) {
        return {
          content: [{ type: 'text' as const, text: 'This tool is only available in Lexios customer sessions.' }],
          isError: true,
        };
      }

      const data: Record<string, unknown> = {
        type: 'lexios_track_analysis',
        chatJid: ctx.chatJid,
        pages: args.pages,
        timestamp: new Date().toISOString(),
      };

      ctx.writeIpcFile(ctx.MESSAGES_DIR, data);

      return {
        content: [{
          type: 'text' as const,
          text: `Analysis tracked: ${args.pages} pages processed.`,
        }],
      };
    },
  );

  // ── Lexios building management tools ──────────────────────────────────

  server.tool(
    'lexios_track_document',
    'Track a document upload in the Lexios building system. Call after processing a document (PDF, DWG, DXF).',
    {
      filename: z.string().describe('Original filename'),
      file_type: z.string().describe('File type: pdf, dwg, dxf, png, jpg'),
      discipline: z.string().optional().describe('Discipline: architectural, structural, mep, civil'),
      sheet_number: z.string().optional().describe('Sheet number, e.g. "A1.1"'),
      revision: z.string().optional().describe('Revision, e.g. "R2" (default: "R1")'),
      replaces_id: z.string().optional().describe('ID of previous document this replaces (for revisions)'),
    },
    async (args) => {
      if (!ctx.groupFolder.startsWith('lexios-')) {
        return { content: [{ type: 'text' as const, text: 'This tool is only available in Lexios sessions.' }], isError: true };
      }

      const { responseFile } = writeLexiosRequest(ctx, {
        type: 'lexios_track_document',
        filename: args.filename,
        file_type: args.file_type,
        discipline: args.discipline,
        sheet_number: args.sheet_number,
        revision: args.revision || 'R1',
        replaces_id: args.replaces_id,
      });

      const result = await ctx.pollResponse(responseFile, 10000);
      if (!result) return { content: [{ type: 'text' as const, text: 'Document tracking request timed out.' }], isError: true };
      if (result.error) return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }], isError: true };
      return { content: [{ type: 'text' as const, text: `Document tracked: ${args.filename} (${args.file_type}, ${args.revision || 'R1'})` }] };
    },
  );

  server.tool(
    'lexios_add_member',
    'Add or update a member in the Lexios building group. Owner/admin can set roles.',
    {
      phone: z.string().describe('Phone number of the member (e.g. "1234567890")'),
      role: z.enum(['owner', 'admin', 'uploader', 'viewer']).default('viewer').describe('Role to assign'),
    },
    async (args) => {
      if (!ctx.groupFolder.startsWith('lexios-')) {
        return { content: [{ type: 'text' as const, text: 'This tool is only available in Lexios sessions.' }], isError: true };
      }

      const { responseFile } = writeLexiosRequest(ctx, {
        type: 'lexios_add_member',
        phone: args.phone,
        role: args.role,
      });

      const result = await ctx.pollResponse(responseFile, 10000);
      if (!result) return { content: [{ type: 'text' as const, text: 'Add member request timed out.' }], isError: true };
      if (result.error) return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }], isError: true };
      return { content: [{ type: 'text' as const, text: `Member ${args.phone} set to role: ${args.role}` }] };
    },
  );

  server.tool(
    'lexios_get_members',
    'List all members of this Lexios building group with their roles and permissions.',
    {},
    async () => {
      if (!ctx.groupFolder.startsWith('lexios-')) {
        return { content: [{ type: 'text' as const, text: 'This tool is only available in Lexios sessions.' }], isError: true };
      }

      const { responseFile } = writeLexiosRequest(ctx, { type: 'lexios_get_members' });

      const result = await ctx.pollResponse(responseFile, 10000);
      if (!result) return { content: [{ type: 'text' as const, text: 'Get members request timed out.' }], isError: true };
      if (result.error) return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }], isError: true };
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.members, null, 2) }] };
    },
  );

  server.tool(
    'lexios_check_permission',
    'Check if a phone number has permission for an action in this building.',
    {
      phone: z.string().describe('Phone number to check'),
      action: z.enum(['upload', 'query', 'invite', 'remove', 'billing']).describe('Action to check'),
    },
    async (args) => {
      if (!ctx.groupFolder.startsWith('lexios-')) {
        return { content: [{ type: 'text' as const, text: 'This tool is only available in Lexios sessions.' }], isError: true };
      }

      const { responseFile } = writeLexiosRequest(ctx, {
        type: 'lexios_check_permission',
        phone: args.phone,
        action: args.action,
      });

      const result = await ctx.pollResponse(responseFile, 10000);
      if (!result) return { content: [{ type: 'text' as const, text: 'Permission check timed out.' }], isError: true };
      if (result.error) return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }], isError: true };
      return { content: [{ type: 'text' as const, text: result.allowed ? `Allowed: ${args.phone} can ${args.action}` : `Denied: ${args.phone} cannot ${args.action}` }] };
    },
  );

  server.tool(
    'lexios_track_query',
    'Track a query in the Lexios analytics system. Call after answering a user question.',
    {
      query_text: z.string().describe('The user query text'),
      category: z.string().optional().describe('Query category: location, quantity, specification, compliance, general'),
      complexity: z.string().optional().describe('Query complexity: simple, moderate, complex, critical'),
      route: z.string().optional().describe('How the query was answered: cache, extraction, llm'),
      answer_preview: z.string().optional().describe('First 200 chars of the answer'),
    },
    async (args) => {
      if (!ctx.groupFolder.startsWith('lexios-')) {
        return { content: [{ type: 'text' as const, text: 'This tool is only available in Lexios sessions.' }], isError: true };
      }

      ctx.writeIpcFile(ctx.MESSAGES_DIR, {
        type: 'lexios_track_query',
        chatJid: ctx.chatJid,
        groupFolder: ctx.groupFolder,
        query_text: args.query_text,
        category: args.category,
        complexity: args.complexity,
        route: args.route,
        answer_preview: args.answer_preview,
        timestamp: new Date().toISOString(),
      });

      return { content: [{ type: 'text' as const, text: 'Query tracked.' }] };
    },
  );

  server.tool(
    'lexios_select_model',
    'Ask the host to recommend the optimal model for a Lexios extraction task. Returns model ID, tier, and endpoint based on current system resources and task complexity.',
    {
      task_type: z.enum(['extraction', 'compliance', 'full_analysis', 'comparison', 'qa']).describe('Type of Lexios task'),
      mode: z.enum(['quick', 'standard', 'comprehensive']).describe('Extraction mode'),
      page_count: z.number().int().min(1).optional().describe('Number of pages to process'),
      is_compliance: z.boolean().default(false).describe('True if checking safety-critical compliance (IBC/ADA/NFPA)'),
    },
    async (args) => {
      if (!ctx.groupFolder.startsWith('lexios-')) {
        return { content: [{ type: 'text' as const, text: 'This tool is only available in Lexios sessions.' }], isError: true };
      }

      const { responseFile } = writeLexiosRequest(ctx, {
        type: 'lexios_select_model',
        task_type: args.task_type,
        mode: args.mode,
        page_count: args.page_count,
        is_compliance: args.is_compliance,
      });

      const result = await ctx.pollResponse(responseFile, 10000);
      if (!result) return { content: [{ type: 'text' as const, text: 'Model selection request timed out.' }], isError: true };
      if (result.error) return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }], isError: true };
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'lexios_save_extraction',
    'Save extraction results so follow-up queries can access them without re-running the extraction pipeline. Call this after completing document analysis.',
    {
      extraction_data: z.string().describe('The full extraction JSON as a string'),
      document_filename: z.string().describe('Original document filename (e.g. "floor-plan.pdf")'),
    },
    async (args) => {
      if (!ctx.groupFolder.startsWith('lexios-')) {
        return { content: [{ type: 'text' as const, text: 'This tool is only available in Lexios sessions.' }], isError: true };
      }

      const { responseFile } = writeLexiosRequest(ctx, {
        type: 'lexios_save_extraction',
        extraction_data: args.extraction_data,
        document_filename: args.document_filename,
      });

      const result = await ctx.pollResponse(responseFile, 10000);
      if (!result) return { content: [{ type: 'text' as const, text: 'Save extraction request timed out.' }], isError: true };
      if (result.error) return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }], isError: true };
      return { content: [{ type: 'text' as const, text: `Extraction saved (${args.document_filename}). Follow-up queries will use cached results.` }] };
    },
  );

  // ── Lexios Jurisdiction Builder tools ──────────────────────────────────

  server.tool(
    'lexios_add_jurisdiction',
    `Add a new jurisdiction to the Lexios compliance database. Each jurisdiction is a complete product unit.
If parent_id is set, rules are inherited from the parent. Use this when researching a new county/city's building codes.

Example:
  id: "GA-cobb-county"
  name: "Cobb County, GA"
  state: "GA"
  level: "county"
  parent_id: "base-ibc-2021"
  adopted_code: "IBC 2021 with GA State Amendments"
  adopted_code_year: 2021`,
    {
      id: z.string().describe('Jurisdiction ID, e.g. "GA-cobb-county"'),
      name: z.string().describe('Display name, e.g. "Cobb County, GA"'),
      state: z.string().describe('State code, e.g. "GA"'),
      level: z.enum(['state', 'county', 'city']).describe('Jurisdiction level'),
      parent_id: z.string().optional().describe('Parent jurisdiction ID for rule inheritance (e.g. "base-ibc-2021")'),
      adopted_code: z.string().describe('Adopted code name, e.g. "IBC 2021 with GA State Amendments"'),
      adopted_code_year: z.number().int().describe('Year of adopted code'),
      adopted_residential_code: z.string().optional().describe('Residential code if different from commercial'),
      source_url: z.string().optional().describe('URL where code adoption info was found'),
      completeness: z.number().int().min(0).max(100).default(0).describe('How complete the research is (0-100%)'),
      notes: z.string().optional().describe('Research notes'),
    },
    async (args) => {
      const { responseFile } = writeJurisdictionRequest(ctx, {
        type: 'lexios_add_jurisdiction',
        ...args,
      });

      const result = await ctx.pollResponse(responseFile, 15000);
      if (!result) return { content: [{ type: 'text' as const, text: 'Error: add_jurisdiction request timed out' }], isError: true };
      if (result.error) return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }], isError: true };

      const inherited = result.inherited_rules ? ` (inherited ${result.inherited_rules} rules from ${args.parent_id})` : '';
      return { content: [{ type: 'text' as const, text: `Jurisdiction added: ${args.id} — ${args.name}${inherited}` }] };
    },
  );

  server.tool(
    'lexios_add_rule',
    `Add an effective rule to a jurisdiction. Use this when you find specific code requirements during research.

check_type values: min_dimension, max_dimension, min_count, max_distance, boolean, ratio, min_area, max_area

Example:
  jurisdiction_id: "GA-douglas-county"
  code: "IBC"
  section: "1005.1"
  title: "Minimum corridor width (Douglas amendment)"
  category: "egress"
  check_type: "min_dimension"
  threshold_value: 48
  threshold_unit: "inches"
  amendment_source: "Douglas Ord. 2022-15"`,
    {
      jurisdiction_id: z.string().describe('Target jurisdiction ID'),
      code: z.string().describe('Code reference: IBC, IRC, ADA, NFPA-101, NEC, etc.'),
      section: z.string().describe('Section number, e.g. "1005.1"'),
      title: z.string().describe('Rule title'),
      category: z.string().describe('Category: egress, fire, structural, accessibility, plumbing, mechanical, electrical, energy, general'),
      requirement_text: z.string().describe('Full requirement text'),
      check_type: z.enum(['min_dimension', 'max_dimension', 'min_count', 'max_distance', 'boolean', 'ratio', 'min_area', 'max_area']).describe('Type of check'),
      threshold_value: z.number().optional().describe('Numeric threshold (e.g. 44 for 44 inches)'),
      threshold_unit: z.string().optional().describe('Unit: inches, feet, sqft, count, percent, hours, psf, etc.'),
      conditions: z.record(z.string(), z.unknown()).optional().describe('Conditions as JSON (e.g. {"occupant_load_gte": 50})'),
      severity: z.enum(['critical', 'major', 'minor']).default('major').describe('Rule severity'),
      extraction_types: z.array(z.string()).optional().describe('Which extraction types feed this check (e.g. ["egress_paths"])'),
      extraction_field: z.string().optional().describe('Field to check (e.g. "width")'),
      amendment_source: z.string().optional().describe('Source of amendment (e.g. "Douglas Ord. 2022-15")'),
    },
    async (args) => {
      const { responseFile } = writeJurisdictionRequest(ctx, {
        type: 'lexios_add_rule',
        ...args,
      });

      const result = await ctx.pollResponse(responseFile, 15000);
      if (!result) return { content: [{ type: 'text' as const, text: 'Error: add_rule request timed out' }], isError: true };
      if (result.error) return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }], isError: true };
      return { content: [{ type: 'text' as const, text: `Rule added (#${result.rule_id}): ${args.code} ${args.section} — ${args.title}` }] };
    },
  );

  server.tool(
    'lexios_add_meta',
    `Add metadata to a jurisdiction (fees, submission requirements, common rejections, reviewer notes, etc.).

Common keys:
  fee_residential_per_sqft, fee_commercial_per_sqft, submission_format, submission_documents,
  common_rejection_1, common_rejection_2, reviewer_note_1, inspection_hours, plan_review_turnaround`,
    {
      jurisdiction_id: z.string().describe('Target jurisdiction ID'),
      key: z.string().describe('Metadata key'),
      value: z.string().describe('Metadata value'),
      source_url: z.string().optional().describe('URL where this info was found'),
    },
    async (args) => {
      const { responseFile } = writeJurisdictionRequest(ctx, {
        type: 'lexios_add_meta',
        ...args,
      });

      const result = await ctx.pollResponse(responseFile, 10000);
      if (!result) return { content: [{ type: 'text' as const, text: 'Error: add_meta request timed out' }], isError: true };
      if (result.error) return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }], isError: true };
      return { content: [{ type: 'text' as const, text: `Metadata added: ${args.jurisdiction_id}.${args.key} = ${args.value.slice(0, 80)}` }] };
    },
  );

  server.tool(
    'lexios_get_coverage',
    `Get jurisdiction coverage: which jurisdictions exist, how complete they are, and what to research next.
Returns all jurisdictions with their rule counts and completeness percentages.`,
    {},
    async () => {
      const { responseFile } = writeJurisdictionRequest(ctx, {
        type: 'lexios_get_coverage',
      });

      const result = await ctx.pollResponse(responseFile, 10000);
      if (!result) return { content: [{ type: 'text' as const, text: 'Error: get_coverage request timed out' }], isError: true };
      if (result.error) return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }], isError: true };
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
