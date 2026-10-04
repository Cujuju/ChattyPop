// Types of the renderer slots bundled plugins contribute to (docs/plugin-architecture.md §3). A leaf module: plugins import
// it at load time, while the registry (./bundled) imports the plugins.
import type { Component, JSX } from 'solid-js';
import type { ArchiveMessage } from '@shared/contract';
import type { MenuItem } from '@/state/ui';
import type { SettingsPageId } from '@shared/anchors';
import type { SettingsSectionDef } from '@/views/settings/SettingsLayout';

export type { RuleTemplate } from '@shared/ruleTemplates';

/** A line of the composer's `/` menu for a command ChattyPop answers itself; picking it types `prefix`. */
export interface ComposerCommand {
  prefix: string;
  /** Also matched against what was typed after the slash (e.g. the command's plain name). */
  name: string;
  description: string;
}

export type { SettingsPageId } from '@shared/anchors';

/** A Settings tab (SettingsDialog). */
export interface SettingsTab {
  id: string;
  label: string;
  /** First of a group: a divider goes above it. */
  groupStart?: true;
  /** 24-unit line icon paths; stroke and size come from SettingsDialog.module.css. */
  icon: () => JSX.Element;
  body: () => JSX.Element;
}

export type { MessageMenuScope } from './readSlots';

export type { UnreadSource } from '@shared/unread';
