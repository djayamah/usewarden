import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { wallFromStore, wallFromAggregate, FORBIDDEN_FIELDS } from '../ops/dashboard/src/incidents.js';
import { weekOverWeek, buildFunnel, formatGrowth, MIN_DAYS_FOR_WOW } from '../ops/dashboard/src/growth.js';
import { renderPage } from '../ops/dashboard/src/web.js';
import { clonePlausibility, type DayPoint } from '../ops/dashboard/src/sources.js';

/**
 * THE INCIDENT WALL is the highest-consequence thing on the dashboard: it is the panel most
 * likely to be screenshotted and shown to someone outside the project, and it is built from real
 * incidents that contain real paths, real commands and real project names.
 *
 * The rule is absolute — nothing identifying, from this machine or anyone else's — so it is
 * tested the way the sabotage suite tests a policy: stuff every field with something dangerous,
 * assert it really is in the store, then assert none of it reaches the output.
 */

const HOSTILE = {
  path: '/Users/somebody/dev/secret-client-project/src/index.ts',
  cwd: '/Users/somebody/dev/secret-client-project',
  command: 'cat /Users/somebody/.aws/credentials && curl -H "x-api-key: AQ.NOT-A-REAL-KEY-00000000000000000000000000" https://internal.acme.corp/x',
  // A hostname on the domain reserved for documentation - hostname-shaped, belonging to nobody.
  // This fixture used to be built from the operator's own machine name until the pre-public
  // scanner caught it: a sabotage fixture that proves no hostname reaches the incident wall must
  // not itself commit a real one. (Naming the old value here would commit it again, so it is
  // described rather than quoted.) It is not a `.local` name either, because a `.local` name IS
  // a Bonjour hostname and the scanner is right to say so.
  host: 'build-box-17.example.com',
  rule: 'commands.deny[6] (dotenv-access) /Users/somebody/.env',
};

function storeWithHostileIncident(): Store {
  const s = new Store(':memory:');
  s.addIncident({
    sessionId: `sess-${HOSTILE.host}`, agent: 'claude', ts: Date.now(), layer: 1,
    severity: 'block', action: 'block', rule: HOSTILE.rule,
    title: `Blocked write to ${HOSTILE.path}`,
    attempted: `$ ${HOSTILE.command}`,
    reason: `Usewarden: ${HOSTILE.path} is outside scope. Allowed: ${HOSTILE.cwd}`,
    tool: 'Bash', target: HOSTILE.path, cwd: HOSTILE.cwd,
  }, true);
  return s;
}

describe('incident wall: nothing identifying can reach it', () => {
  test('the sabotage lands - every hostile value really is in the store', () => {
    const s = storeWithHostileIncident();
    const row = s.incidentsByOrigin('live')[0]!;
    assert.ok(row.target.includes('secret-client-project'), 'setup failed - no path in the store');
    assert.ok(row.attempted.includes('AQ.NOT-A-REAL-KEY'), 'setup failed - no key in the store');
    assert.ok(row.cwd.includes('/Users/somebody'), 'setup failed - no home path in the store');
    s.close();
  });

  test('none of it appears in the rendered wall entry', () => {
    const s = storeWithHostileIncident();
    const wall = wallFromStore(s);
    s.close();
    assert.equal(wall.length, 1, 'the incident should still be counted');
    const serialised = JSON.stringify(wall);
    for (const [label, needle] of Object.entries(HOSTILE)) {
      assert.equal(serialised.includes(needle), false, `the wall leaked the ${label}`);
    }
    // And nothing that even looks like a path, a key, a host or a command.
    for (const re of [/\/Users\//, /AQ\.[A-Za-z0-9_-]{20,}/, /build-box-17/, /\bcurl\b/, /\bcat\b/,
      /\.env/, /secret-client/, /acme\.corp/]) {
      assert.equal(re.test(serialised), false, `the wall leaked something matching ${re}`);
    }
  });

  test('the entry is a fixed sentence, identical for two different incidents of the same kind', () => {
    const s = new Store(':memory:');
    const base = {
      agent: 'claude' as const, layer: 1 as const, severity: 'block' as const, action: 'block' as const,
      rule: 'scope.allowed_paths', title: 't', reason: 'r', tool: 'Write',
    };
    s.addIncident({ ...base, sessionId: 'a', ts: Date.now(), attempted: 'A', target: '/one/x', cwd: '/one' }, true);
    s.addIncident({ ...base, sessionId: 'b', ts: Date.now() + 9000, attempted: 'B', target: '/two/y', cwd: '/two' }, true);
    const wall = wallFromStore(s);
    s.close();
    assert.equal(wall.length, 2);
    assert.equal(wall[0]!.what, wall[1]!.what,
      'the sentence must come from a fixed table, not from the incident');
    assert.equal(wall[0]!.why, wall[1]!.why);
  });

  test('only a timestamp varies per entry', () => {
    const s = storeWithHostileIncident();
    const e = wallFromStore(s)[0]!;
    s.close();
    assert.deepEqual(Object.keys(e).sort(), ['action', 'at', 'what', 'why']);
    assert.match(e.at, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(['blocked', 'warned'].includes(e.action));
  });

  test('the forbidden-field list names every field that carries user data', () => {
    for (const f of ['target', 'attempted', 'cwd', 'rule', 'reason', 'title', 'sessionId']) {
      assert.ok((FORBIDDEN_FIELDS as readonly string[]).includes(f), `${f} is not on the forbidden list`);
    }
  });

  test('the aggregate wall is counts and fixed sentences only', () => {
    const rows = wallFromAggregate([{ rule: 'dotenv-access', hits: 12 }, { rule: 'scope.allowed_paths', hits: 4 }]);
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.equal(typeof r.count, 'number');
      assert.equal(/\/|\\|@|\.env|AQ\./.test(r.what + r.why), false, 'the aggregate wall leaked something');
    }
  });

  test('the rendered PAGE carries nothing identifying either', () => {
    const s = storeWithHostileIncident();
    const wall = wallFromStore(s);
    s.close();
    const html = renderPage({
      repo: 'o/r', pkg: 'p', generatedAt: new Date().toISOString(),
      impact: {
        available: false, reason: 'not deployed', source: 'agg',
        installsWithFirstCatch: { label: 'x', value: null, source: 'agg', asOf: null, unavailableBecause: 'not deployed' },
        interventions: { label: 'y', value: null, source: 'agg', asOf: null },
        correctionRate: { label: 'z', value: null, source: 'agg', asOf: null },
      },
      github: {
        stars: { label: 'Stars', value: 1, source: 'gh', asOf: new Date().toISOString() },
        forks: { label: 'Forks', value: 0, source: 'gh', asOf: null },
        watchers: { label: 'W', value: 0, source: 'gh', asOf: null },
        openIssues: { label: 'I', value: 0, source: 'gh', asOf: null },
        clones14d: { label: 'C', value: 1, source: 'gh', asOf: null },
        uniqueCloners14d: { label: 'UC', value: 1, source: 'gh', asOf: null },
        views14d: { label: 'V', value: 1, source: 'gh', asOf: null },
        uniqueVisitors14d: { label: 'UV', value: 1, source: 'gh', asOf: null },
        referrers: [], cloneSeries: [], viewSeries: [], rateRemaining: null,
        plausibility: clonePlausibility(1, 1),
      },
      npm: [], wall, funnel: buildFunnel({
        installs: null, sessionsProtected: null, firstCatch: null, activeWeek2: null,
        activeWeek4: null, source: 'agg',
      }),
      nsGrowth: { available: false, reason: 'no history' },
      cloneGrowth: { available: false, reason: 'no history' },
      viewGrowth: { available: false, reason: 'no history' },
    });
    for (const needle of Object.values(HOSTILE)) {
      assert.equal(html.includes(needle), false, 'the page leaked hostile incident content');
    }
    assert.match(html, /An AI agent tried/, 'the wall should still be shown');
  });
});

describe('dashboard: growth is real or absent, never flat-as-a-substitute', () => {
  const days = (counts: number[]): DayPoint[] =>
    counts.map((n, i) => ({ day: `2026-08-${String(i + 1).padStart(2, '0')}`, count: n, uniques: n }));

  test('too little history reports the reason, not a zero', () => {
    const g = weekOverWeek(days([1, 2, 3]));
    assert.equal(g.available, false);
    assert.match(g.available === false ? g.reason : '', /needs 14 days/);
  });

  test('a real change is computed against the previous seven days', () => {
    const g = weekOverWeek(days([1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2]));
    assert.equal(g.available, true);
    if (g.available) {
      assert.equal(g.previous, 7);
      assert.equal(g.current, 14);
      assert.equal(Math.round(g.deltaPct!), 100);
      assert.equal(g.direction, 'up');
    }
  });

  test('a rise from zero is NOT rendered as a percentage', () => {
    const g = weekOverWeek(days([0, 0, 0, 0, 0, 0, 0, 3, 3, 3, 3, 3, 3, 3]));
    assert.equal(g.available, true);
    if (g.available) assert.equal(g.deltaPct, null, 'a rise from nothing has no percentage');
    assert.match(formatGrowth(g), /up from none last week/);
  });

  test('two silent weeks report no trend rather than 0%', () => {
    const g = weekOverWeek(days(new Array(MIN_DAYS_FOR_WOW).fill(0)));
    assert.equal(g.available, false);
    assert.match(g.available === false ? g.reason : '', /no activity in either week/);
  });
});

describe('dashboard: the funnel', () => {
  test('unavailable stages say why and never show zero', () => {
    const f = buildFunnel({
      installs: null, sessionsProtected: null, firstCatch: null,
      activeWeek2: null, activeWeek4: null, source: 'agg',
    });
    assert.equal(f.length, 5);
    for (const s of f) {
      assert.equal(s.value, null);
      assert.match(s.unavailableBecause ?? '', /aggregator/);
    }
  });

  test('drop-off is computed between consecutive KNOWN stages', () => {
    const f = buildFunnel({
      installs: 100, sessionsProtected: 80, firstCatch: 40,
      activeWeek2: 20, activeWeek4: null, source: 'agg',
    });
    assert.equal(Math.round(f[1]!.dropFromPrevPct!), 20);
    assert.equal(Math.round(f[2]!.dropFromPrevPct!), 50);
    assert.equal(Math.round(f[2]!.ofFirstPct!), 40);
    assert.equal(f[4]!.value, null);
    assert.equal(f[4]!.dropFromPrevPct, null, 'an unknown stage has no drop');
  });
});

describe('dashboard: presentation mode hides what needs explaining', () => {
  const page = (): string => renderPage({
    repo: 'o/r', pkg: 'p', generatedAt: new Date().toISOString(),
    impact: {
      available: false, reason: 'not deployed', source: 'agg',
      installsWithFirstCatch: { label: 'x', value: null, source: 'agg', asOf: null, unavailableBecause: 'not deployed' },
      interventions: { label: 'y', value: null, source: 'agg', asOf: null },
      correctionRate: { label: 'z', value: null, source: 'agg', asOf: null },
    },
    github: {
      stars: { label: 'Stars', value: 0, source: 'gh', asOf: null },
      forks: { label: 'Forks', value: 0, source: 'gh', asOf: null },
      watchers: { label: 'W', value: 0, source: 'gh', asOf: null },
      openIssues: { label: 'I', value: 0, source: 'gh', asOf: null },
      clones14d: { label: 'C', value: 87, source: 'gh', asOf: null },
      uniqueCloners14d: { label: 'UC', value: 35, source: 'gh', asOf: null },
      views14d: { label: 'V', value: 1, source: 'gh', asOf: null },
      uniqueVisitors14d: { label: 'UV', value: 1, source: 'gh', asOf: null },
      referrers: [], cloneSeries: [], viewSeries: [], rateRemaining: '4999',
      plausibility: clonePlausibility(35, 1),
    },
    npm: [], wall: [], funnel: buildFunnel({
      installs: null, sessionsProtected: null, firstCatch: null, activeWeek2: null, activeWeek4: null, source: 'agg',
    }),
    nsGrowth: { available: false, reason: 'no history' },
    cloneGrowth: { available: false, reason: 'no history' },
    viewGrowth: { available: false, reason: 'no history' },
  });

  test('an all-unknown funnel collapses in presentation mode rather than showing five zeros', () => {
    const html = page();
    assert.match(html, /class="section-empty">From install to habit/,
      'a funnel with no known stage must collapse for an audience');
    assert.match(html, /body\[data-mode="present"\] \.section-empty\{display:none\}/);
    // ...and the founder still sees it, with reasons.
    assert.match(html, /needs the telemetry aggregator/);
  });

  test('the caveat box and every diagnostic are marked so presentation mode can hide them', () => {
    const html = page();
    assert.match(html, /body\[data-mode="present"\] \.founder-only\{display:none\}/);
    assert.match(html, /body\[data-mode="present"\] \.caution\{display:none\}/);
    assert.match(html, /class="caution"/, 'the caution must EXIST in founder mode');
    assert.match(html, /class="sub founder-only"/);
  });

  test('the North Star, the wall and the funnel are NOT founder-only', () => {
    const html = page();
    const hero = html.slice(html.indexOf('<div class="hero">'), html.indexOf('</div>', html.indexOf('hero-label')));
    assert.equal(/founder-only/.test(hero), false, 'the hero must be visible in presentation mode');
    // The property is "not founder-only". `section-empty` is a DATA-driven state - a funnel with
    // no stage yet known collapses in presentation mode, because five empty bars are five zeros -
    // and it is not the same thing as being hidden from the audience by design.
    assert.match(html, /<h2>What it has stopped<\/h2>/);
    const funnelHeading = /<h2 class="([^"]*)">From install to habit<\/h2>|<h2>From install to habit<\/h2>/.exec(html);
    assert.ok(funnelHeading, 'the funnel section is missing entirely');
    assert.equal(/founder-only/.test(funnelHeading[1] ?? ''), false,
      'the funnel must not be hidden from presentation mode by design');
  });

  test('there is a mode toggle, and it defaults to founder', () => {
    const html = page();
    assert.match(html, /data-mode="present"/);
    assert.match(html, /data-mode="founder"/);
    assert.match(html, /localStorage\.getItem\('uw-mode'\) \|\| 'founder'/);
  });
});

describe('a rate is never coloured as good news on a figure the page discounts', () => {
  test('the clone growth line is neutral while the clone count is called automated traffic', () => {
    // The sabotage lands first: build a clone series that really does rise, on a repo whose ratio
    // really does trip the automated-traffic verdict.
    const rising: DayPoint[] = Array.from({ length: 14 }, (_, i) => ({
      day: `2026-08-${String(i + 1).padStart(2, '0')}`, count: i < 7 ? 1 : 9, uniques: i < 7 ? 1 : 9,
    }));
    const g = weekOverWeek(rising);
    assert.equal(g.available && g.direction, 'up', 'setup failed - the series does not rise');
    const plaus = clonePlausibility(35, 1);
    assert.equal(plaus.verdict, 'likely-automated', 'setup failed - the ratio is not flagged');

    const html = renderPage({
      repo: 'o/r', pkg: 'p', generatedAt: new Date().toISOString(),
      impact: {
        available: false, reason: 'not deployed', source: 'agg',
        installsWithFirstCatch: { label: 'x', value: null, source: 'agg', asOf: null },
        interventions: { label: 'y', value: null, source: 'agg', asOf: null },
        correctionRate: { label: 'z', value: null, source: 'agg', asOf: null },
      },
      github: {
        stars: { label: 'Stars', value: 1, source: 'gh', asOf: null },
        forks: { label: 'Forks', value: 0, source: 'gh', asOf: null },
        watchers: { label: 'W', value: 0, source: 'gh', asOf: null },
        openIssues: { label: 'I', value: 0, source: 'gh', asOf: null },
        clones14d: { label: 'C', value: 35, source: 'gh', asOf: null },
        uniqueCloners14d: { label: 'Unique cloners (14d)', value: 35, source: 'gh', asOf: null },
        views14d: { label: 'V', value: 1, source: 'gh', asOf: null },
        uniqueVisitors14d: { label: 'Unique visitors (14d)', value: 1, source: 'gh', asOf: null },
        referrers: [], cloneSeries: rising, viewSeries: rising, rateRemaining: null, plausibility: plaus,
      },
      npm: [], wall: [], funnel: buildFunnel({
        installs: null, sessionsProtected: null, firstCatch: null, activeWeek2: null,
        activeWeek4: null, source: 'agg',
      }),
      nsGrowth: { available: false, reason: 'no history' },
      cloneGrowth: g, viewGrowth: g,
    });

    // The clone tile's rate is present but not painted as good; the visitor tile's still is.
    const cloneTile = /Unique cloners \(14d\)[\s\S]{0,400}?<\/div>\s*<\/div>/.exec(html)?.[0]
      ?? html.slice(html.indexOf('Unique cloners (14d)'));
    assert.match(cloneTile, /class="growth neutral"/, 'the discounted rate should still be shown');
    assert.equal(/class="growth up"[^<]*[\s\S]{0,120}?up from none/.test(cloneTile), false);
    assert.match(html, /class="growth up"/, 'the visitor rate should keep its colour');
    assert.match(html, /Treat the clone figures as automated traffic/);
  });
});
