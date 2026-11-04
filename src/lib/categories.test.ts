import { test } from "node:test";
import assert from "node:assert/strict";
import { competitionAge, eligibleAgeGroups, AGE_GROUP_NAMES } from "./categories.js";

// A tournament on 10 Nov 2026, 9:00 am IST
const T = new Date("2026-11-10T03:30:00Z");
const born = (iso: string) => new Date(`${iso}T00:00:00Z`); // how dates of birth are stored
const groups = (iso: string) => eligibleAgeGroups(born(iso), T, AGE_GROUP_NAMES);

test("only the birth year counts, never the month or day", () => {
  assert.equal(competitionAge(born("2010-01-01"), T), 16);
  assert.equal(competitionAge(born("2010-12-31"), T), 16);
});

test("birth years from the TNJA circular for 2026", () => {
  assert.deepEqual(groups("2020-06-01"), ["Mini Sub-Junior Age Group 1"]);
  assert.deepEqual(groups("2019-12-31"), ["Mini Sub-Junior Age Group 1"]);
  assert.deepEqual(groups("2018-01-01"), ["Mini Sub-Junior Age Group 2"]);
  assert.deepEqual(groups("2017-05-05"), ["Mini Sub-Junior Age Group 2"]);
  assert.deepEqual(groups("2016-05-05"), ["Mini Sub-Junior Age Group 3"]);
  assert.deepEqual(groups("2015-05-05"), ["Mini Sub-Junior Age Group 3"]);
  assert.deepEqual(groups("2014-05-05"), ["Sub-Junior"]);
  assert.deepEqual(groups("2013-05-05"), ["Sub-Junior"]);
  // 2012: Sub-Junior, Cadet and Junior (not Senior: that starts at 2011)
  assert.deepEqual(groups("2012-05-05"), ["Sub-Junior", "Cadet", "Junior"]);
  assert.deepEqual(groups("2011-05-05"), ["Cadet", "Junior", "Senior"]);
  assert.deepEqual(groups("2010-05-05"), ["Cadet", "Junior", "Senior"]);
  assert.deepEqual(groups("2009-05-05"), ["Junior", "Senior"]);
  assert.deepEqual(groups("2007-05-05"), ["Junior", "Senior"]);
  assert.deepEqual(groups("2006-05-05"), ["Senior"]);
  assert.deepEqual(groups("1990-05-05"), ["Senior"]);
});
