// Docs: https://www.instantdb.com/docs/modeling-data

import { i } from "@instantdb/react";

const _schema = i.schema({
  entities: {
    $files: i.entity({
      path: i.string().unique().indexed(),
      url: i.string(),
    }),
    $streams: i.entity({
      abortReason: i.string().optional(),
      clientId: i.string().unique().indexed(),
      done: i.boolean().optional(),
      size: i.number().optional(),
    }),
    $users: i.entity({
      email: i.string().unique().indexed().optional(),
      imageURL: i.string().optional(),
      type: i.string().optional(),
    }),

    // School PTO opt-in family directory.
    families: i.entity({
      // Household / last name shown in the directory.
      name: i.string().indexed(),
    }),
    parents: i.entity({
      firstName: i.string(),
      lastName: i.string().indexed(),
      email: i.string(), // required
      // Address + phones are optional in the directory.
      street: i.string().optional(),
      city: i.string().optional(),
      state: i.string().optional(),
      zip: i.string().optional(),
      homePhone: i.string().optional(),
      workPhone: i.string().optional(),
      mobilePhone: i.string().optional(),
    }),
    children: i.entity({
      firstName: i.string(),
      lastName: i.string().indexed(),
      // ISO date string, e.g. "2013-01-12".
      birthDate: i.string(),
    }),
    teachers: i.entity({
      firstName: i.string(),
      lastName: i.string().indexed(),
      // Grade as a number; Kindergarten is stored as 0, displayed as "K".
      grade: i.number(),
    }),
  },
  links: {
    $streams$files: {
      forward: {
        on: "$streams",
        has: "many",
        label: "$files",
      },
      reverse: {
        on: "$files",
        has: "one",
        label: "$stream",
        onDelete: "cascade",
      },
    },
    $usersLinkedPrimaryUser: {
      forward: {
        on: "$users",
        has: "one",
        label: "linkedPrimaryUser",
        onDelete: "cascade",
      },
      reverse: {
        on: "$users",
        has: "many",
        label: "linkedGuestUsers",
      },
    },

    // A family links to up to 2 parents (enforced by the seed script).
    familyParents: {
      forward: { on: "families", has: "many", label: "parents" },
      reverse: { on: "parents", has: "one", label: "family", onDelete: "cascade" },
    },
    // A family links to any number of children.
    familyChildren: {
      forward: { on: "families", has: "many", label: "children" },
      reverse: { on: "children", has: "one", label: "family", onDelete: "cascade" },
    },
    // Each child has exactly one current teacher.
    childCurrentTeacher: {
      forward: { on: "children", has: "one", label: "currentTeacher" },
      reverse: { on: "teachers", has: "many", label: "currentStudents" },
    },
    // A child links to any number of past teachers.
    childPastTeachers: {
      forward: { on: "children", has: "many", label: "pastTeachers" },
      reverse: { on: "teachers", has: "many", label: "pastStudents" },
    },
  },
  rooms: {},
});

// This helps TypeScript display nicer intellisense
type _AppSchema = typeof _schema;
interface AppSchema extends _AppSchema {}
const schema: AppSchema = _schema;

export type { AppSchema };
export default schema;
