// Scenario: inbound sales lead scoring and routing.
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const maybe = (p) => Math.random() < p;

const names = [
  'Alex', 'Priya', 'Jordan', 'Sam', 'Maria', 'Chen', 'Liam', 'Nina', 'Omar', 'Fatima',
  'Jake', 'Elena', 'Tariq', 'Grace', 'Noah', 'Ines', 'Marco', 'Yuki', 'Diego', 'Hannah',
];
const companies = [
  'Northwind Traders', 'Globex', 'Initech', 'Umbrella Labs', 'Acme Studio', 'Vertex Digital',
  'Bluepeak', 'Riverside Goods', 'Cascade Analytics', 'Foundry Works', 'Lumen Health', 'Pathwise',
];

const templatesByCategory = {
  smb: [
    "Hi, I run {company}, a small shop with about {n} people. We're looking at your product — what does pricing look like for a team our size?",
    "Just me and one other person at {company} right now, but growing. Is there a free plan or trial?",
    "We're a small team at {company}, would love to try this out before committing to anything.",
  ],
  midmarket: [
    "We're a team of about {n} at {company}, evaluating options to replace our current tool. Could someone walk us through what plan makes sense?",
    "I'm {role} at {company} ({n} employees). We're comparing a few vendors this quarter, can we set up a call?",
    "Looking to roll this out to our {n}-person department at {company}. What's the process for getting started?",
  ],
  enterprise: [
    "I'm {role} at {company}, a company of {n}+ employees. We need to understand security/compliance and custom pricing before we can move forward.",
    "We're standardizing on a single vendor across {company} globally ({n}+ people). Can we get a dedicated account rep?",
    "Our procurement team at {company} needs an SSO and SLA overview before we can consider this at scale ({n}+ seats).",
  ],
  partnership: [
    "We run an agency that implements tools like yours for clients — is there a partner or reseller program we could join?",
    "I'd like to explore an integration between {company} and your platform, who handles partnerships?",
    "We're interested in becoming a certified reseller, could you send over partner program details?",
  ],
  not_a_fit: [
    "Hey, I'm a student working on a class project, is there a free version I could try?",
    "Just checking out competitors for a report I'm writing, do you have public pricing?",
    "Are you hiring? I saw an open role and wanted to ask about the interview process.",
    "This looks cool, just poking around, no real use case yet though.",
  ],
};

const roles = ['the IT Director', 'a Procurement Manager', 'the Head of Ops', 'a VP of Engineering', 'the CTO'];

function makeItem(category) {
  const template = rand(templatesByCategory[category]);
  const text = template
    .replace('{company}', rand(companies))
    .replace('{n}', String(Math.floor(5 + Math.random() * 4995)))
    .replace('{role}', rand(roles));
  const name = rand(names);
  return `Hi, ${name} here. ${text}`.trim();
}

function generate(count = 150) {
  const categoryKeys = Object.keys(templatesByCategory);
  const items = [];
  const perCategory = Math.floor(count / categoryKeys.length);
  for (const category of categoryKeys) {
    for (let i = 0; i < perCategory; i++) items.push({ text: makeItem(category) });
  }
  while (items.length < count) items.push({ text: makeItem(rand(categoryKeys)) });
  items.length = count;

  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  items.forEach((it, i) => (it.id = i + 1));
  return items;
}

module.exports = {
  key: 'leads',
  label: 'Lead scoring',
  description: 'Qualification and routing of inbound leads by team and lead strength',
  itemNoun: { singular: 'lead', plural: 'leads' },
  inputPlaceholder: 'Type a lead message and watch Jev qualify it instantly...',

  categories: [
    { key: 'smb', label: 'SMB', color: '#f5a623', criteria: 'Small business or individual, likely low deal size, self-serve fit' },
    { key: 'midmarket', label: 'Mid-Market', color: '#4a90d9', criteria: 'Medium-sized company, moderate budget, needs a sales-assisted process' },
    { key: 'enterprise', label: 'Enterprise', color: '#9b59b6', criteria: 'Large organization, big budget signals, needs a dedicated account executive' },
    { key: 'partnership', label: 'Partnerships', color: '#2ecc71', criteria: 'Reseller, integration, or partnership inquiry rather than a direct buyer' },
    { key: 'not_a_fit', label: 'Not a Fit', color: '#8b93a7', criteria: 'Student, hobbyist, competitor research, or clearly not a real buying inquiry' },
  ],
  categoryQuestion: { instructions: 'Which team should own following up on this inbound lead?' },

  severityQuestion: {
    label: 'Lead strength',
    instructions: 'How strong a buying signal is this lead?',
    criteria: [
      'Not a real fit or very unlikely to convert',
      'Some interest but early, or low budget signals',
      'Good fit with clear intent to buy',
      'Hot lead — strong budget and urgency signals',
    ],
  },
  slaHoursBySeverity: [72, 24, 4, 1],

  humanQuestion: {
    label: 'Needs personal outreach',
    instructions: 'Does this lead need a personal outreach call or email from a sales rep rather than an automated nurture email?',
  },

  actionQuestion: {
    label: 'Suggested next step',
    instructions: 'Which next action should sales take as the starting point for this lead? Only pick a specific action if it genuinely fits; otherwise pick none.',
    noneCriteria: "Doesn't clearly match any of the other actions, or the message is too vague to act on",
  },
  actions: [
    {
      key: 'book_demo',
      label: 'Book a demo call',
      criteria: 'Lead is ready for a live product demo',
      body: "Thanks for reaching out! I'd love to show you around — here's my calendar link to grab a time that works: [link].",
    },
    {
      key: 'send_pricing',
      label: 'Send pricing & self-serve signup',
      criteria: 'Lead just wants pricing info or wants to self-serve sign up',
      body: "Thanks for your interest! Here's our pricing page and you can get started right away: [link]. Happy to answer any questions.",
    },
    {
      key: 'enterprise_intro',
      label: 'Enterprise intro from AE',
      criteria: 'Large company that needs a dedicated account executive to scope the deal',
      body: "Thanks for reaching out — I'm looping in our enterprise account team, they'll follow up shortly to understand your needs in more detail.",
    },
    {
      key: 'partnership_route',
      label: 'Route to partnerships team',
      criteria: 'Reseller, integration, or partnership inquiry',
      body: "Thanks for your interest in partnering with us! I'm forwarding this to our partnerships team, they'll be in touch soon.",
    },
    {
      key: 'nurture_sequence',
      label: 'Add to nurture sequence',
      criteria: 'Some interest but not ready to buy yet, needs long-term nurturing',
      body: "Thanks for signing up! We'll keep you posted with useful resources and updates until you're ready to talk further.",
    },
    {
      key: 'polite_decline',
      label: 'Polite decline / not a fit',
      criteria: 'Clearly not a real buying inquiry (student, competitor research, hobbyist)',
      body: "Thanks for reaching out! Based on what you've shared, this might not be the right fit right now, but feel free to check back if things change.",
    },
  ],

  agentNoun: { singular: 'rep', plural: 'reps' },
  agents: {
    smb: ['Beatriz', 'Rui'],
    midmarket: ['Sofia', 'André'],
    enterprise: ['Carla', 'Tiago'],
    partnership: ['Rita', 'Pedro'],
    not_a_fit: ['Sara', 'Bruno'],
  },

  generate,
};
