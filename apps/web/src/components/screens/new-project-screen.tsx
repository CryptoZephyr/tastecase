'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Form } from 'react-aria-components';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { PageHeader, Panel } from '@/components/ui/page';
import { ErrorState } from '@/components/ui/states';
import { useApi } from '@/lib/api/context';
import { isUncertain, type UiError } from '@/lib/api/result';
import { SCHEMA_VERSION } from '@/lib/ids';
import { routes } from '@/lib/routes';

export function NewProjectScreen() {
  const api = useApi();
  const router = useRouter();
  const [name, setName] = useState('');
  const [error, setError] = useState<UiError | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed) return setFieldError('Give the project a name.');
    if (trimmed.length > 160) return setFieldError('Use 160 characters or fewer.');
    setFieldError(null); setError(null); setPending(true);
    const result = await api.projects.create({ schema_version: SCHEMA_VERSION, name: trimmed });
    setPending(false);
    if (result.ok) router.push(routes.setup(result.data.id));
    else setError(result.error);
  }

  return (
    <div className="mx-auto w-full max-w-[760px] px-4 py-8 md:px-8">
      <PageHeader title="Bring your assistant" description="Create a private project for one assistant. Next you’ll issue a runner credential, import your restaurant catalog and define the task." />
      <Panel className="mt-8">
        <Form onSubmit={event => { event.preventDefault(); void submit(); }} className="space-y-5" validationBehavior="aria">
          <Field label="Project name" isRequired value={name} onChange={value => { setName(value); setFieldError(null); }} errorMessage={fieldError}
            description="For example, the assistant or team this project tests. You can’t rename it yet." maxLength={160} />
          {error && isUncertain(error) ? (
            <Notice tone="advisory" title="We don’t know whether the project was created" role="alert" actions={<>
              <Link href={routes.projects} className="font-medium text-action underline underline-offset-4">Check your projects</Link>
              <Button variant="secondary" type="submit" isPending={pending}>Try again</Button>
            </>}>
              <p>TasteCase didn’t confirm the request. Check your project list first — sending it again could create a second project with the same name.</p>
            </Notice>
          ) : error ? <ErrorState error={error} what="project creation" /> : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" isPending={pending} pendingLabel="Creating project">Create project</Button>
            <Link href={routes.projects} className="text-control text-action underline-offset-4 hover:underline">Cancel</Link>
          </div>
        </Form>
      </Panel>
      <ul className="mt-6 space-y-2 text-control text-ink-2">
        <li>Your assistant’s provider keys never go to TasteCase. A local runner on your machine calls your assistant and uploads typed results.</li>
        <li>TasteCase only accepts results from runners holding this project’s credential, and you can revoke it at any time.</li>
      </ul>
    </div>
  );
}
