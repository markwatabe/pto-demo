import { useMemo, useState } from 'react';
import {
  Alert,
  Body,
  Caption,
  Inline,
  PageHeader,
  PageShell,
  Spinner,
  Stack,
  Strong,
} from '@apygee/atoms';
import { DataTable, type DataTableColumnDef } from '@apygee/data-table';
import { db } from '../db';

// Query families with nested parents, children, and each child's teachers.
const DIRECTORY_QUERY = {
  families: {
    parents: {},
    children: {
      currentTeacher: {},
      pastTeachers: {},
    },
  },
} as const;

type Teacher = { id: string; firstName: string; lastName: string; grade: number };
type Child = {
  id: string;
  firstName: string;
  lastName: string;
  birthDate: string;
  currentTeacher?: Teacher;
  pastTeachers?: Teacher[];
};
type Parent = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
  homePhone?: string;
  workPhone?: string;
  mobilePhone?: string;
};
type Family = { id: string; name: string; parents?: Parent[]; children?: Child[] };

const COLUMNS: DataTableColumnDef<Family>[] = [
  {
    id: 'parents',
    header: 'Parents',
    enableSorting: false,
    accessorFn: (family) => (family.parents ?? []).map((p) => `${p.firstName} ${p.lastName}`).join(' '),
    size: 320,
    cell: ({ row }) => {
      const parents = row.original.parents ?? [];
      if (parents.length === 0) return <Body>—</Body>;
      return (
        <Stack gap="md">
          {parents.map((parent) => (
            <ParentBlock key={parent.id} parent={parent} />
          ))}
        </Stack>
      );
    },
  },
  {
    id: 'children',
    header: 'Children',
    enableSorting: false,
    accessorFn: (family) => (family.children ?? []).map((c) => `${c.firstName} ${c.lastName}`).join(' '),
    size: 320,
    cell: ({ row }) => {
      const children = row.original.children ?? [];
      if (children.length === 0) return <Body>—</Body>;
      return (
        <Stack gap="md">
          {children.map((child) => (
            <ChildBlock key={child.id} child={child} />
          ))}
        </Stack>
      );
    },
  },
];

export function DirectoryPage() {
  const [filter, setFilter] = useState('');
  const { isLoading, error, data } = db.useQuery(DIRECTORY_QUERY);

  const families = (data?.families ?? []) as Family[];

  // Filter across family, parent, and child names. The DataTable's built-in
  // global filter only sees flat cell values, so we drive its toolbar search
  // box (filterValue/onFilterValueChange) against this nested match instead.
  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const sorted = [...families].sort((a, b) => a.name.localeCompare(b.name));
    if (!q) return sorted;
    return sorted.filter((family) => {
      const haystack = [
        family.name,
        ...(family.parents ?? []).map((p) => `${p.firstName} ${p.lastName}`),
        ...(family.children ?? []).map((c) => `${c.firstName} ${c.lastName}`),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [families, filter]);

  return (
    <PageShell width="xl">
      <Stack gap="xl">
        <PageHeader
          eyebrow="PTO"
          title="Family directory"
          description="An opt-in directory of families. Search by family, parent, or child name."
        />

        {isLoading ? (
          <Stack gap="md" align="center">
            <Spinner />
          </Stack>
        ) : error ? (
          <Alert tone="danger" title="Could not load the directory" description={error.message} />
        ) : (
          <DataTable<Family>
            data={rows}
            columns={COLUMNS}
            ariaLabel="Family directory"
            getRowId={(family) => family.id}
            density="comfortable"
            filterValue={filter}
            onFilterValueChange={setFilter}
            filterPlaceholder="Search families, parents, or children…"
            rowCountLabel={(visible) => `${visible} ${visible === 1 ? 'family' : 'families'}`}
            emptyState="No families match your search. Try a different name."
          />
        )}
      </Stack>
    </PageShell>
  );
}

function ParentBlock({ parent }: { parent: Parent }) {
  const address = [parent.street, joinCityStateZip(parent)].filter(Boolean).join(', ');
  const phones = [
    parent.homePhone ? `H: ${parent.homePhone}` : null,
    parent.workPhone ? `W: ${parent.workPhone}` : null,
    parent.mobilePhone ? `M: ${parent.mobilePhone}` : null,
  ].filter(Boolean);

  return (
    <Stack gap="xs">
      <Strong>{`${parent.lastName}, ${parent.firstName}`}</Strong>
      <Body>{parent.email}</Body>
      {address ? <Caption>{address}</Caption> : null}
      {phones.length > 0 ? <Caption>{phones.join('  ·  ')}</Caption> : null}
    </Stack>
  );
}

function ChildBlock({ child }: { child: Child }) {
  const current = child.currentTeacher;
  const past = child.pastTeachers ?? [];

  return (
    <Stack gap="xs">
      <Inline gap="sm" align="center" wrap>
        <Strong>{`${child.lastName}, ${child.firstName}`}</Strong>
        <Caption>{`Age ${ageFrom(child.birthDate)}`}</Caption>
      </Inline>
      {current ? (
        <Caption>{`Current: ${teacherName(current)} · Grade ${gradeLabel(current.grade)}`}</Caption>
      ) : null}
      {past.length > 0 ? <Caption>{`Past: ${past.map(teacherName).join(', ')}`}</Caption> : null}
    </Stack>
  );
}

function joinCityStateZip(parent: Parent): string {
  const cityState = [parent.city, parent.state].filter(Boolean).join(', ');
  return [cityState, parent.zip].filter(Boolean).join(' ');
}

function teacherName(t: Teacher): string {
  return `${t.lastName}, ${t.firstName}`;
}

function gradeLabel(grade: number): string {
  return grade === 0 ? 'K' : String(grade);
}

function ageFrom(birthDate: string): number {
  const born = new Date(birthDate);
  const now = new Date();
  let age = now.getFullYear() - born.getFullYear();
  const monthDiff = now.getMonth() - born.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < born.getDate())) {
    age--;
  }
  return age;
}
