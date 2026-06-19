import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { internals } from '../src/index.mjs';

function writeSkill(root, name, description) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nUse this skill for ${description}.\n`,
  );
  return dir;
}

test('Stow-folded user skill root works through ~/.agents/skills only', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'stronk-pi-skill-roots.'));
  const sourceRoot = join(tmp, 'source-skills');
  const homeRoot = join(tmp, 'home-skills');
  const sourceSkill = writeSkill(sourceRoot, 'exec-plan', 'exec plan tests');
  const homeSkill = join(homeRoot, 'exec-plan');
  mkdirSync(homeSkill, { recursive: true });
  symlinkSync(join(sourceSkill, 'SKILL.md'), join(homeSkill, 'SKILL.md'));

  const rootsJson = JSON.stringify([{ path: homeRoot, scope: 'user' }]);

  const inventory = internals.loadSkillInventory(rootsJson);
  assert.deepEqual(inventory.skills.map((skill) => skill.name), ['exec-plan']);
  assert.equal(inventory.skills[0].path, join(realpathSync(homeSkill), 'SKILL.md'));
  assert.equal(inventory.skills[0].realPath, realpathSync(join(sourceSkill, 'SKILL.md')));

  const suggestions = internals.buildSkillAutocompleteSuggestions('use $exec', { rootsJson });
  assert.equal(suggestions.items.length, 1);
  assert.equal(suggestions.items[0].value, '$exec-plan ');

  const injection = internals.buildSkillInjectionContext('use $exec-plan', { rootsJson, cwd: tmp });
  assert.equal(injection.blocks.length, 1);
  assert.match(injection.blocks[0], /<name>exec-plan<\/name>/);
});

test('repo skill root does not follow SKILL.md symlink escapes', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'stronk-pi-skill-roots.'));
  const sourceRoot = join(tmp, 'source-skills');
  const repoRoot = join(tmp, 'repo-skills');
  const sourceSkill = writeSkill(sourceRoot, 'external-skill', 'outside repo root');
  const repoSkill = join(repoRoot, 'external-skill');
  mkdirSync(repoSkill, { recursive: true });
  symlinkSync(join(sourceSkill, 'SKILL.md'), join(repoSkill, 'SKILL.md'));

  const rootsJson = JSON.stringify([{ path: repoRoot, scope: 'repo' }]);

  const inventory = internals.loadSkillInventory(rootsJson);
  assert.deepEqual(inventory.skills, []);
  assert.equal(internals.buildSkillAutocompleteSuggestions('use $external', { rootsJson }), null);
});

test('duplicate Stow-folded user skills insert linked mentions with visible paths', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'stronk-pi-skill-roots.'));
  const sourceRoot = join(tmp, 'source-skills');
  const homeRoot = join(tmp, 'home-skills');
  const otherRoot = join(tmp, 'other-skills');
  const sourceSkill = writeSkill(sourceRoot, 'shared-skill', 'stow duplicate');
  const otherSkill = writeSkill(otherRoot, 'shared-skill', 'regular duplicate');
  const homeSkill = join(homeRoot, 'shared-skill');
  mkdirSync(homeSkill, { recursive: true });
  symlinkSync(join(sourceSkill, 'SKILL.md'), join(homeSkill, 'SKILL.md'));

  const homeSkillPath = join(realpathSync(homeSkill), 'SKILL.md');
  const rootsJson = JSON.stringify([
    { path: homeRoot, scope: 'user' },
    { path: otherRoot, scope: 'user' },
  ]);

  const suggestions = internals.buildSkillAutocompleteSuggestions('use $shared', { rootsJson });
  assert.equal(suggestions.items.length, 2);

  const stowItem = suggestions.items.find((item) => item.value.includes(homeSkillPath));
  assert.ok(stowItem);
  assert.equal(stowItem.value, `[$shared-skill](skill://${homeSkillPath}) `);

  const injection = internals.buildSkillInjectionContext(`use ${stowItem.value.trim()}`, { rootsJson, cwd: tmp });
  assert.equal(injection.blocks.length, 1);
  assert.match(injection.blocks[0], /<name>shared-skill<\/name>/);
  assert.ok(injection.blocks[0].includes(`<path>${homeSkillPath}</path>`));
  assert.ok(!injection.blocks[0].includes(`<path>${join(realpathSync(otherSkill), 'SKILL.md')}</path>`));
});
