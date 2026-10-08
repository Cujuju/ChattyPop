// Context menus of the rules list: a rule's copy, group and delete; a group separator's rename and removal.
import type { Rule } from '@shared/rules';
import { failureNotice, textDialog } from '@/state/dialogs';
import { confirmDeleteRule, duplicateRule, setRuleGroup } from '@/state/rules';
import type { MenuGroup } from '@/ui/menuTypes';

/** Asks for a separator's name; null when cancelled or blank. */
const askGroupName = (title: string, confirmLabel: string, value?: string): Promise<string | null> =>
  textDialog({ title, message: 'Separator name', confirmLabel, value });

/** An owner rule's menu; `groups` are the named groups in list order. */
export function ruleMenu(r: Rule, groups: readonly string[]): MenuGroup[] {
  const regroup = (group: string | null): Promise<void> => setRuleGroup([r.id], group).catch(failureNotice("Couldn't move the rule"));
  return [
    { items: [{ label: 'Duplicate', icon: 'copy', detail: 'Adds a copy, turned off', run: () => duplicateRule(r).catch(failureNotice("Couldn't duplicate the rule")) }] },
    {
      items: [
        {
          label: 'Add separator…',
          icon: 'plus',
          detail: 'A named group, starting with this rule',
          run: async () => {
            const name = await askGroupName('Add separator', 'Add');
            if (name) await regroup(name);
          },
        },
        ...(groups.length
          ? [{
              label: 'Move to',
              icon: 'swap' as const,
              submenu: [{
                exclusive: true,
                items: [
                  ...groups.map((g) => ({ label: g, icon: 'group' as const, checked: r.group === g, run: () => regroup(g) })),
                  { label: 'No separator', icon: 'close' as const, checked: r.group === null, run: () => regroup(null) },
                ],
              }],
            }]
          : []),
      ],
    },
    { items: [{ label: 'Delete', icon: 'trash', danger: true, run: () => confirmDeleteRule(r).then(() => undefined, failureNotice("Couldn't delete the rule")) }] },
  ];
}

/** A separator's menu; `ids` are its rules, filtered out ones included. */
export function separatorMenu(name: string, ids: number[]): MenuGroup[] {
  return [
    {
      items: [
        {
          label: 'Rename separator…',
          icon: 'edit',
          run: async () => {
            const next = await askGroupName('Rename separator', 'Rename', name);
            if (next && next !== name) await setRuleGroup(ids, next).catch(failureNotice("Couldn't rename the separator"));
          },
        },
        {
          label: 'Remove separator',
          icon: 'trash',
          detail: 'Its rules stay, ungrouped',
          danger: true,
          run: () => setRuleGroup(ids, null).catch(failureNotice("Couldn't remove the separator")),
        },
      ],
    },
  ];
}
