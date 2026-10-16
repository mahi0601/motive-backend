// Starter client templates for common agency work. They have the same snapshot shape as a saved
// client template (see workspaceCopy.service.js#collectStructure) and go through the same
// cleanStructure when used, so they can never carry anything a saved one could not. Dates are day
// offsets from the start date the owner picks. Ids are `builtin:<key>`, which cannot collide with
// a saved template's cuid.
const task = (title, day, priority = 'Medium', subtasks = [], category = 'Client work') => ({
  title,
  description: null,
  priority,
  category,
  tags: [],
  recurrence: null,
  due: day == null ? null : { offset: day, time: 0 },
  subtasks,
});
const milestone = (title, day) => ({ title, date: { offset: day, time: 0 } });

const snapshot = ({ headline, summary, accent, tasks, milestones }) => ({
  version: 1,
  status: { headline, summary, accent },
  tasks,
  pages: [],
  milestones,
});

const TEMPLATES = [
  {
    key: 'website-project',
    name: 'Website project',
    description: 'Brief to launch for a new website: discovery, design, build, review and go-live.',
    snapshot: snapshot({
      headline: 'Your new website',
      summary: 'We are working through discovery, design, build and launch. This page shows where each step stands.',
      accent: 'blue',
      tasks: [
        task('Kickoff call and project brief', 0, 'High'),
        task('Collect logo, brand assets and content', 3, 'Medium', ['Logo files', 'Brand colours and fonts', 'Page copy and images']),
        task('Sitemap and page list approved', 5, 'High'),
        task('Homepage design', 10, 'High'),
        task('Inner page designs', 14, 'Medium'),
        task('Design sign-off by client', 16, 'High'),
        task('Build pages', 28, 'High'),
        task('Mobile and browser testing', 32, 'Medium'),
        task('Client review and changes', 35, 'High'),
        task('Go-live checklist and launch', 40, 'High', ['Domain and hosting', 'Forms and analytics', 'Backups']),
      ],
      milestones: [milestone('Design approved', 16), milestone('Site ready for review', 35), milestone('Launch', 40)],
    }),
  },
  {
    key: 'seo-retainer',
    name: 'SEO retainer',
    description: 'A first three months of SEO: audit, fixes, content and a monthly report.',
    snapshot: snapshot({
      headline: 'Search growth plan',
      summary: 'A monthly plan to improve how your site shows up in search. Each month ends with a report.',
      accent: 'teal',
      tasks: [
        task('Site audit and baseline rankings', 0, 'High'),
        task('Keyword research and priority pages', 7, 'High'),
        task('Fix technical issues from the audit', 14, 'High', ['Page speed', 'Broken links', 'Mobile usability']),
        task('Improve titles and descriptions on priority pages', 21, 'Medium'),
        task('Publish content batch 1', 28, 'Medium'),
        task('Month 1 report and review call', 30, 'High'),
        task('Publish content batch 2', 45, 'Medium'),
        task('Build links and local listings', 55, 'Medium'),
        task('Month 2 report and review call', 60, 'High'),
        task('Publish content batch 3', 75, 'Medium'),
        task('Month 3 report and next-quarter plan', 90, 'High'),
      ],
      milestones: [milestone('Month 1 report', 30), milestone('Month 2 report', 60), milestone('Month 3 report', 90)],
    }),
  },
  {
    key: 'social-media-month',
    name: 'Social media month',
    description: 'A monthly content cycle: plan, create, approve, publish and report.',
    snapshot: snapshot({
      headline: 'This month on social media',
      summary: 'The content plan for the month, from calendar to approval to publishing.',
      accent: 'rose',
      tasks: [
        task('Content calendar for the month', 0, 'High'),
        task('Calendar approved by client', 3, 'High'),
        task('Design posts, week 1 and 2', 7, 'Medium'),
        task('Write captions and hashtags', 8, 'Medium'),
        task('Client approval of week 1 and 2 posts', 10, 'High'),
        task('Publish week 1 and 2 posts', 12, 'Medium'),
        task('Design posts, week 3 and 4', 17, 'Medium'),
        task('Client approval of week 3 and 4 posts', 20, 'High'),
        task('Publish week 3 and 4 posts', 22, 'Medium'),
        task('Monthly performance report', 28, 'High'),
      ],
      milestones: [milestone('Calendar approved', 3), milestone('Month report sent', 28)],
    }),
  },
  {
    key: 'video-production',
    name: 'Video production',
    description: 'From brief to delivery of a video: script, shoot, edit, review and final files.',
    snapshot: snapshot({
      headline: 'Your video project',
      summary: 'Script, shoot, edit and delivery. This page shows each stage and what needs your approval.',
      accent: 'violet',
      tasks: [
        task('Creative brief and references', 0, 'High'),
        task('Script and storyboard', 5, 'High'),
        task('Script approved by client', 7, 'High'),
        task('Plan shoot: location, crew and schedule', 9, 'Medium'),
        task('Shoot day', 14, 'High'),
        task('First rough cut', 21, 'High'),
        task('Client feedback on rough cut', 24, 'High'),
        task('Final edit, sound and colour', 30, 'Medium'),
        task('Final approval by client', 33, 'High'),
        task('Export and deliver files', 35, 'High', ['Master file', 'Social media versions', 'Subtitles']),
      ],
      milestones: [milestone('Script approved', 7), milestone('Rough cut review', 24), milestone('Final delivery', 35)],
    }),
  },
];

const PREFIX = 'builtin:';
const byId = new Map(TEMPLATES.map((t) => [`${PREFIX}${t.key}`, t]));

exports.PREFIX = PREFIX;
exports.isBuiltinId = (id) => typeof id === 'string' && id.startsWith(PREFIX);
exports.getBuiltin = (id) => byId.get(id) || null;
exports.listBuiltin = () => TEMPLATES.map((t) => ({ id: `${PREFIX}${t.key}`, name: t.name, description: t.description, snapshot: t.snapshot }));
