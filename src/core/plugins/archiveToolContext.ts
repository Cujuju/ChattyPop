// Descriptor-checked archive tool registrations and activation-scoped callers.
import { archiveToolName } from '@shared/aiToolNames';
import type { PluginDescriptor } from '@shared/bundledTypes';
import { listArchiveTools, registerArchiveTool, runArchiveTool, type ArchiveTool } from '../ai/archiveTools';
import { joined, untilRevoked } from '../ai/revocable';
import type { Db } from '../db';
import type { PluginAi } from './aiContext';
import { servicesLive, type Registrations } from './api';
import { registration } from './registrationCheck';
import { checkArchiveToolSchema } from './archiveToolSchema';

/** Checks the JSON Schema object required by model tool interfaces before publishing it. */
function checkTool(tool: ArchiveTool): void {
  if (typeof tool.description !== 'string' || !tool.description.trim() || typeof tool.run !== 'function') {
    throw new TypeError(`AI tool ${tool.name} needs a description and run function.`);
  }
  checkArchiveToolSchema(tool.name, tool.parameters);
}

/** Tools supplied and consumed by one activation. The testing host uses this same adapter. */
export function archiveToolServices(
  plugin: PluginDescriptor,
  order: number,
  db: () => Db,
  reg: Registrations,
  lifetime: AbortSignal,
  fail: (err: unknown) => void,
): PluginAi['tools'] {
  const id = plugin.manifest.id;
  return {
    provide: (tools) => {
      if (!servicesLive(reg)) return;
      if (!reg.handlers) throw new Error(`${id} provides AI tools during activate.`);
      const pending = new Set<string>();
      for (const tool of tools) {
        archiveToolName(id, tool.name);
        if (!plugin.aiTools?.includes(tool.name)) throw new Error(`${id} provides AI tool ${tool.name} but declares none.`);
        const key = registration('AI tool', tool.name);
        if (reg.registered.has(key) || pending.has(key)) throw new Error(`${id} provides AI tool ${tool.name} more than once.`);
        checkTool(tool);
        pending.add(key);
      }
      for (const tool of tools) {
        const name = archiveToolName(id, tool.name);
        const info = { name, plugin: id, pluginName: plugin.manifest.name, description: tool.description, parameters: tool.parameters };
        reg.disposers.push(registerArchiveTool(db(), order, info, tool, lifetime, fail));
        reg.registered.add(registration('AI tool', tool.name));
      }
    },
    list: () => servicesLive(reg) ? listArchiveTools(db(), id) : [],
    run: (name, args, scope, signal) => {
      const active = joined(lifetime, signal);
      return untilRevoked(active, () => runArchiveTool(db(), id, name, args, scope, active));
    },
  };
}
