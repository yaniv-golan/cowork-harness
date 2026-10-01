// The id the agent binary registers a plugin skill under, read from the plugin skill loader of the staged agent
// (2.1.284). A SKILL.md directly in a skills path registers `<plugin>:<name>`, the name being its frontmatter `name`
// (minus a leading "<plugin>:") or the path's basename; a skill directory found inside a skills path registers
// `<plugin>:<directory name>`. Either way the name half has every character outside [a-zA-Z0-9_-] replaced by "-",
// one "-" per UTF-16 code unit (the regex carries no `u` flag), and the plugin half is used as it is.
//
// The one copy of that rule: anything that predicts a registered id (to match an observed one) goes through here.

/** A skill name as the loader writes it into the id: every UTF-16 code unit outside [a-zA-Z0-9_-] becomes "-". */
export function sanitizeSkillName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-");
}

/** The id the loader registers for `name` (a skill directory's name, or a root SKILL.md's frontmatter name or
 *  fallback) in the plugin `pluginName`: `<pluginName>:<sanitizeSkillName(name)>`. */
export function registeredSkillId(pluginName: string, name: string): string {
  return `${pluginName}:${sanitizeSkillName(name)}`;
}
