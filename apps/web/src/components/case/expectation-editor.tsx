'use client';

import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox, CheckboxGroup, RadioCard, RadioGroup } from '@/components/ui/choice';
import { Field, NativeSelect } from '@/components/ui/field';
import type { ApprovedExpectation } from '@/lib/api/types';
import { newId } from '@/lib/ids';
import { entryFacts, type CaseView } from '@/lib/view/case-view';

export type PolicyRuleDraft = { key: string; kind: 'recommend_any' | 'avoid' | 'order'; profileId: 'a' | 'b'; entryIds: string[]; before: string; after: string };
export interface ExpectationDraft {
  classification: 'advisory' | 'approved_policy' | 'objective_contract';
  advisoryRationale: string;
  policyRules: PolicyRuleDraft[];
  objectiveProfiles: ('a' | 'b')[];
  objectiveRules: ('output_schema' | 'allowed_ids' | 'exclusions')[];
  exclusionIds: string[];
}

export function initialExpectationDraft(view: CaseView): ExpectationDraft {
  return { classification: 'advisory', advisoryRationale: view.proposedRationale, policyRules: [], objectiveProfiles: [...view.profiles], objectiveRules: ['output_schema'], exclusionIds: [...view.constraints.excludedEntryIds] };
}

/** Validates against the same scope rules as the contracts (validateApprovedExpectation). */
export function buildExpectation(draft: ExpectationDraft, view: CaseView): { expectation?: ApprovedExpectation; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (draft.classification === 'advisory') {
    if (!draft.advisoryRationale.trim()) errors.advisory = 'Explain why this contrast matters.';
    if (draft.advisoryRationale.length > 2000) errors.advisory = 'Use 2,000 characters or fewer.';
    return errors.advisory ? { errors } : { errors, expectation: { classification: 'advisory', automaticFailure: false, humanReviewRequired: true, contrastId: view.contrastId, rationale: draft.advisoryRationale.trim() } };
  }
  if (draft.classification === 'approved_policy') {
    if (!draft.policyRules.length) errors.policy = 'Add at least one rule.';
    const seen = new Set<string>();
    const rules = draft.policyRules.map(rule => {
      if (rule.kind === 'order') {
        if (!rule.before || !rule.after || rule.before === rule.after) errors[`rule-${rule.key}`] = 'Choose two different eligible restaurants.';
        return { kind: 'order' as const, profileId: rule.profileId, beforeEntryId: rule.before, afterEntryId: rule.after, whenBothPresent: true as const };
      }
      if (!rule.entryIds.length) errors[`rule-${rule.key}`] = 'Choose at least one restaurant.';
      return { kind: rule.kind, profileId: rule.profileId, entryIds: rule.entryIds };
    });
    rules.forEach((rule, index) => { const key = JSON.stringify(rule); if (seen.has(key)) errors[`rule-${draft.policyRules[index].key}`] = 'This rule duplicates another.'; seen.add(key); });
    return Object.keys(errors).length ? { errors } : { errors, expectation: { classification: 'approved_policy', automaticFailure: true, rules } };
  }
  if (!draft.objectiveProfiles.length) errors.objectiveProfiles = 'Apply the checks to at least one profile.';
  if (!draft.objectiveRules.length) errors.objectiveRules = 'Choose at least one check.';
  if (draft.objectiveRules.includes('exclusions') && !draft.exclusionIds.length) errors.objectiveRules = 'Choose the excluded restaurants to check.';
  if (Object.keys(errors).length) return { errors };
  return { errors, expectation: { classification: 'objective_contract', automaticFailure: true, profiles: draft.objectiveProfiles,
    rules: draft.objectiveRules.map(kind => kind === 'output_schema' ? { kind } : kind === 'allowed_ids' ? { kind, entryIds: [...view.catalog.eligible] } : { kind, entryIds: draft.exclusionIds }) } };
}

export function ExpectationEditor({ view, draft, onChange, errors }: { view: CaseView; draft: ExpectationDraft; onChange: (draft: ExpectationDraft) => void; errors: Record<string, string> }) {
  const eligible = view.catalog.entries.filter(entry => view.catalog.eligible.has(entry.id));
  const all = view.catalog.entries;
  const set = (patch: Partial<ExpectationDraft>) => onChange({ ...draft, ...patch });
  const updateRule = (key: string, patch: Partial<PolicyRuleDraft>) => set({ policyRules: draft.policyRules.map(rule => rule.key === key ? { ...rule, ...patch } : rule) });
  const profileOptions = view.profiles.map(profile => ({ value: profile, label: view.profiles.length === 1 ? 'Case brief' : `Profile ${profile.toUpperCase()}` }));
  return (
    <div className="space-y-5 rounded-panel border border-rule p-4">
      <RadioGroup label="What should this test expect?" value={draft.classification} onChange={value => set({ classification: value as ExpectationDraft['classification'] })}>
        <RadioCard value="advisory" title="Keep it advisory" description="Preserve this contrast with your rationale. Never an automatic failure." />
        <RadioCard value="approved_policy" title="Approve a scoped policy" description="Recommend any of, avoid, or order two restaurants for one profile. Comparisons check exactly these rules." />
        <RadioCard value="objective_contract" title="Objective checks" description="Output shape, only eligible restaurants, or never the excluded ones. Mechanical checks, not taste." />
      </RadioGroup>

      {draft.classification === 'advisory' ? (
        <Field label="Expectation rationale" value={draft.advisoryRationale} onChange={value => set({ advisoryRationale: value })} multiline rows={3} maxLength={2000} errorMessage={errors.advisory} />
      ) : null}

      {draft.classification === 'approved_policy' ? (
        <div className="space-y-3">
          {draft.policyRules.map((rule, index) => (
            <fieldset key={rule.key} className="space-y-3 rounded-control bg-subtle p-3">
              <legend className="sr-only">Rule {index + 1}</legend>
              <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                <NativeSelect id={`kind-${rule.key}`} label={`Rule ${index + 1}`} value={rule.kind} onChange={value => updateRule(rule.key, { kind: value as PolicyRuleDraft['kind'], entryIds: [], before: '', after: '' })}
                  options={[{ value: 'recommend_any', label: 'Recommend at least one of' }, { value: 'avoid', label: 'Never recommend' }, { value: 'order', label: 'Order two restaurants (when both appear)' }]} />
                <NativeSelect id={`profile-${rule.key}`} label="Applies to" value={rule.profileId} onChange={value => updateRule(rule.key, { profileId: value as 'a' | 'b' })} options={profileOptions} />
                <Button variant="text" onPress={() => set({ policyRules: draft.policyRules.filter(row => row.key !== rule.key) })} icon={<Trash2 aria-hidden className="size-4" strokeWidth={1.75} />}>Remove</Button>
              </div>
              {rule.kind === 'order' ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <NativeSelect id={`before-${rule.key}`} label="This restaurant first" value={rule.before} onChange={value => updateRule(rule.key, { before: value })} options={[{ value: '', label: 'Choose…' }, ...eligible.map(entry => ({ value: entry.id, label: entry.name }))]} />
                  <NativeSelect id={`after-${rule.key}`} label="…before this one" value={rule.after} onChange={value => updateRule(rule.key, { after: value })} options={[{ value: '', label: 'Choose…' }, ...eligible.map(entry => ({ value: entry.id, label: entry.name }))]} />
                </div>
              ) : (
                <CheckboxGroup label={rule.kind === 'avoid' ? 'Restaurants to never recommend' : 'Eligible restaurants (any one satisfies the rule)'} value={rule.entryIds} onChange={value => updateRule(rule.key, { entryIds: value })}>
                  <div className="grid max-h-56 overflow-y-auto rounded-control border border-rule bg-surface px-3 sm:grid-cols-2">
                    {(rule.kind === 'avoid' ? all : eligible).map(entry => <Checkbox key={entry.id} value={entry.id}>{entry.name}</Checkbox>)}
                  </div>
                </CheckboxGroup>
              )}
              {errors[`rule-${rule.key}`] ? <p className="text-meta font-medium text-failed">{errors[`rule-${rule.key}`]}</p> : null}
            </fieldset>
          ))}
          {errors.policy ? <p className="text-meta font-medium text-failed">{errors.policy}</p> : null}
          <Button variant="secondary" isDisabled={draft.policyRules.length >= 20} icon={<Plus aria-hidden className="size-4" strokeWidth={1.75} />}
            onPress={() => set({ policyRules: [...draft.policyRules, { key: newId(), kind: 'avoid', profileId: view.profiles[0], entryIds: [], before: '', after: '' }] })}>Add a rule</Button>
          <p className="text-meta text-ink-2">A passing policy shows compliance with that rule only — not that the recommendation suits a real person.</p>
        </div>
      ) : null}

      {draft.classification === 'objective_contract' ? (
        <div className="space-y-4">
          {view.profiles.length > 1 ? (
            <CheckboxGroup label="Apply to" value={draft.objectiveProfiles} onChange={value => set({ objectiveProfiles: value as ('a' | 'b')[] })} errorMessage={errors.objectiveProfiles}>
              {view.profiles.map(profile => <Checkbox key={profile} value={profile}>Profile {profile.toUpperCase()}</Checkbox>)}
            </CheckboxGroup>
          ) : null}
          <CheckboxGroup label="Checks" value={draft.objectiveRules} onChange={value => set({ objectiveRules: value as ExpectationDraft['objectiveRules'] })} errorMessage={errors.objectiveRules}>
            <Checkbox value="output_schema">Output matches the expected shape</Checkbox>
            <Checkbox value="allowed_ids">Only recommends eligible restaurants<span className="block text-meta text-ink-2">Exactly the {view.catalog.eligible.size} pinned eligible restaurants.</span></Checkbox>
            <Checkbox value="exclusions" isDisabled={!view.constraints.excludedEntryIds.length}>Never recommends excluded restaurants<span className="block text-meta text-ink-2">{view.constraints.excludedEntryIds.length ? 'From the task’s pinned exclusions.' : 'This task has no excluded restaurants.'}</span></Checkbox>
          </CheckboxGroup>
          {draft.objectiveRules.includes('exclusions') ? (
            <CheckboxGroup label="Excluded restaurants to check" value={draft.exclusionIds} onChange={value => set({ exclusionIds: value })}>
              {view.constraints.excludedEntryIds.map(id => <Checkbox key={id} value={id}>{entryFacts(view.catalog, id).name}</Checkbox>)}
            </CheckboxGroup>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
