'use strict';
/**
 * Browser-side Supabase version of api_client.js for idea-submission.html.
 * No Node, no zod, no build step. It exposes the three globals the page already calls:
 *   submitIdeaForm(data)   -> inserts idea + members + faculty
 *   updateIdeaForm(data)   -> updates them (edit mode)
 *   loadIdeaForEdit()      -> prefill data for edit mode (or null for a fresh submission)
 *
 * Needs the supabase-js <script> before this file, and supabase_direct_writes.sql run once in Supabase.
 * The student ID / roll number is optional for every member.
 */

// ───────────────────────── 1. CONFIG (edit these) ─────────────────────────
const SUPABASE_URL = "https://xqxsyqfpkrdowktzyrbo.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_8dijp37gWwgJDYBqpEkq9Q_BO4FMQwR";

const DB = {
  ideas: 'ideas',
  members: 'team_members',
  faculty: 'faculty_mentors',
  conceptBucket: 'concept-notes',   // private Storage bucket (created by your schema)
};
const CONCEPT_MIMES = ['application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];

const MIN_DOB = '1991-01-01';
const MAX_DOB = '2008-12-31';

// The inline script in the page already refers to `_supabase`; create it here if nothing else has.
if (!window._supabase) window._supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ───────────────────────── 2. ALLOWED VALUES ─────────────────────────
const THEMES = ['natural', 'agriculture', 'food', 'economy', 'greenEnergy', 'ruralDev', 'builtEnviron',
  'healthcare', 'water', 'waste', 'transport', 'livelihood', 'corporate'];
const QUALS = ['bachelors', 'masters', 'phd'];
const DEGREES = ['ba', 'bsc', 'bcom', 'btech', 'bba', 'bca', 'bdesc', 'ma', 'msc', 'mcom', 'mba', 'mca',
  'mtech', 'mdesc', 'llb', 'mbbs', 'bpharm', 'ms'];
const YEARS = ['1', '2', '3', '4', '5'];
const GENDERS = ['Female', 'Male', 'Other', 'Prefer not to say'];
const TRLS = ['trl1', 'trl2', 'trl3', 'trl4', 'trl5', 'trl6', 'trl7', 'trl8', 'trl9'];
const STATES = ['andhra-pradesh', 'arunachal-pradesh', 'assam', 'bihar', 'chhattisgarh', 'goa', 'gujarat',
  'haryana', 'himachal-pradesh', 'jharkhand', 'karnataka', 'kerala', 'madhya-pradesh', 'maharashtra',
  'manipur', 'meghalaya', 'mizoram', 'nagaland', 'odisha', 'punjab', 'rajasthan', 'sikkim', 'tamil-nadu',
  'telangana', 'tripura', 'uttar-pradesh', 'uttarakhand', 'west-bengal', 'JK', 'delhi',
  'daman_diu_dadra_nagar', 'puducherry', 'lakshadweep', 'andaman_nicobar', 'ladakh', 'chandigarh'];

const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const NAME_RE = /^[\p{L}][\p{L} .'-]*$/u;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const wordCount = (s) => s.trim().split(/\s+/).filter(Boolean).length;

// ───────────────────────── 3. VALIDATION ─────────────────────────
/** Returns { ok:true, data } or { ok:false, errors:[{field,message}] } */
function validateIdeaPayload(raw) {
  const body = { ...(raw || {}) };
  const n = Number(body.numberOfMembers);
  if (n === 3) for (const k of Object.keys(body)) if (k.startsWith('member4')) delete body[k];

  const errors = [];
  const fail = (field, message) => {
    if (!errors.some((e) => e.field === field)) errors.push({ field, message });
    return null;
  };
  const str = (x) => (x == null ? '' : String(x).trim());

  const text = (field, label, { min = 1, max = 150, re, reMsg, words, opt = false } = {}) => {
    const s = str(body[field]);
    if (!s) return opt ? null : fail(field, `${label} is required`);
    if (s.length < min) return fail(field, `${label} must be at least ${min} characters`);
    if (s.length > max) return fail(field, `${label} must be at most ${max} characters`);
    if (CTRL.test(s)) return fail(field, `${label} contains invalid characters`);
    if (re && !re.test(s)) return fail(field, reMsg || `${label} is invalid`);
    if (words && wordCount(s) > words) return fail(field, `${label}: maximum ${words} words allowed`);
    return s;
  };
  const essay = (field, label, words, max) => text(field, label, { max, words });
  const oneOf = (field, label, values) => {
    const s = str(body[field]);
    if (!s) return fail(field, `${label} is required`);
    return values.includes(s) ? s : fail(field, `${label} has an invalid value`);
  };
  // select with free-text "Other": the form already overwrites the select value with the typed text
  const selectOrOther = (field, label, allowed, otherKey = 'other') => {
    const s = text(field, label, { max: 100 });
    if (s == null) return null;
    if (allowed.includes(s)) return { key: s, other: null };
    if (['other', 'others'].includes(s.toLowerCase()) || s.length < 2) return fail(field, `Please specify your ${label}`);
    return { key: otherKey, other: s };
  };
  const person = (field, label) => text(field, label, { max: 60, re: NAME_RE, reMsg: `${label} may contain only letters, spaces . ' -` });
  const email = (field, label) => {
    const s = text(field, label, { max: 254 });
    if (s == null) return null;
    const e = s.toLowerCase();
    return EMAIL_RE.test(e) ? e : fail(field, `${label} is not a valid email`);
  };
  const mobile = (field, label, opt = false) =>
    text(field, label, { max: 10, re: /^[6-9]\d{9}$/, reMsg: `${label} must be a 10-digit Indian mobile number`, opt });
  const pincode = (field, label) =>
    text(field, label, { max: 6, re: /^[1-9]\d{5}$/, reMsg: `${label} must be a 6-digit PIN code` });
  const dob = (field, label) => {
    const s = text(field, label, { max: 10, re: /^\d{4}-\d{2}-\d{2}$/, reMsg: `${label} must be a date (YYYY-MM-DD)` });
    if (s == null) return null;
    const d = new Date(`${s}T00:00:00Z`);
    if (isNaN(d) || d.toISOString().slice(0, 10) !== s) return fail(field, `${label} is not a real date`);
    if (s < MIN_DOB || s > MAX_DOB) return fail(field, `${label} must be between ${MIN_DOB} and ${MAX_DOB}`);
    return s;
  };

  const v = {};

  // team
  v.teamName = text('teamName', 'Team name', { min: 2, max: 100 });
  v.theme = selectOrOther('theme', 'Theme', THEMES, 'others');
  v.numberOfMembers = n;
  if (n !== 3 && n !== 4) fail('numberOfMembers', 'Number of members must be 3 or 4');

  // people
  const memberFields = (p, collegeKey, lead) => {
    v[`${p}FirstName`] = person(`${p}FirstName`, 'First name');
    v[`${p}LastName`] = person(`${p}LastName`, 'Last name');
    v[`${p}Gender`] = oneOf(`${p}Gender`, 'Gender', GENDERS);
    v[`${p}Age`] = dob(`${p}Age`, 'Date of birth');
    v[`${p}QualificationLevel`] = selectOrOther(`${p}QualificationLevel`, 'Qualification', QUALS);
    v[`${p}Degree`] = selectOrOther(`${p}Degree`, 'Degree', DEGREES);
    v[`${p}YearSemester`] = selectOrOther(`${p}YearSemester`, 'Year/Semester', YEARS);
    v[collegeKey] = text(collegeKey, 'Institute name', { min: 2, max: 200 });
    v[`${p}StudentId`] = text(`${p}StudentId`, 'Student ID', { min: 3, max: 30, re: /^[A-Za-z0-9/_. -]+$/, reMsg: 'Student ID contains invalid characters', opt: true });
    v[`${p}Email`] = email(`${p}Email`, 'Email');
    v[`${p}Mobile`] = mobile(`${p}Mobile`, 'Mobile number');
    if (lead) {
      v.leadAlternateMobile = mobile('leadAlternateMobile', 'Alternate mobile number', true);
      v.leadCityVillage = text('leadCityVillage', 'Village / City', { max: 100, opt: true });
      v.leadBlock = text('leadBlock', 'Block / Taluka', { max: 100 });
      v.leadDistrict = text('leadDistrict', 'District', { max: 100 });
      v.leadState = oneOf('leadState', 'State', STATES);
      v.leadPincode = pincode('leadPincode', 'PIN code');
    }
  };
  memberFields('lead', 'leadInstitute', true);
  v.leadConfirmEmail = email('leadConfirmEmail', 'Confirm email');
  memberFields('member2', 'member2College');
  memberFields('member3', 'member3College');
  if (n === 4) memberFields('member4', 'member4College');

  // institute
  v.leadCollege = text('leadCollege', 'Full institution name', { min: 2, max: 200 });
  v.collegeCityVillage = text('collegeCityVillage', 'Village / City', { max: 100, opt: true });
  v.collegeBlock = text('collegeBlock', 'Block / Taluka', { max: 100 });
  v.collegeDistrict = text('collegeDistrict', 'District', { max: 100 });
  v.collegeState = oneOf('collegeState', 'State', STATES);
  v.collegePincode = pincode('collegePincode', 'PIN code');

  // faculty mentor
  v.facultyFirstName = person('facultyFirstName', 'Faculty first name');
  v.facultyLastName = person('facultyLastName', 'Faculty last name');
  v.facultyGender = oneOf('facultyGender', 'Faculty gender', GENDERS);
  v.facultyQualification = oneOf('facultyQualification', 'Faculty qualification', [...QUALS, 'other']);
  v.facultyDesignation = text('facultyDesignation', 'Designation', { min: 2, max: 100 });
  v.facultyDepartment = text('facultyDepartment', 'Department', { min: 2, max: 100 });
  v.facultyAreaOfInterest = selectOrOther('facultyAreaOfInterest', 'Area of interest', THEMES, 'others');
  v.facultyExpertise = text('facultyExpertise', 'Area of expertise', { min: 2, max: 300 });
  v.facultyCollege = text('facultyCollege', 'Faculty institute name', { min: 2, max: 200 });
  v.facultyEmail = email('facultyEmail', 'Faculty email');
  v.facultyMobile = mobile('facultyMobile', 'Faculty mobile number');

  // idea content (same limits as the form)
  v.motivation = essay('motivation', 'Problem statement', 100, 650);
  v.challengeImportance = essay('challengeImportance', 'Problem validation', 200, 1250);
  v.beneficiaries = essay('beneficiaries', 'Beneficiaries', 150, 950);
  v.solutionDescription = essay('solutionDescription', 'Solution description', 250, 1550);
  v.innovation = essay('innovation', 'Innovation', 200, 1250);
  v.developmentStage = oneOf('developmentStage', 'Technology Readiness Level', TRLS);
  v.technologyApproach = essay('technologyApproach', 'Technical approach', 250, 1550);
  v.expectedImpact = essay('expectedImpact', 'Expected impact', 150, 950);
  v.teamSkills = essay('teamSkills', 'Team skills', 150, 950);
  v.challenge = essay('challenge', 'Scalability plan', 100, 650);

  // sustainability pillars: "env-50,hum-20,cul-20,social-10,eco-0" -> must total 100
  const m = /^env-(\d{1,3}),hum-(\d{1,3}),cul-(\d{1,3}),social-(\d{1,3}),eco-(\d{1,3})$/.exec(str(body.feasibility));
  const p = m ? m.slice(1).map(Number) : null;
  if (!p || p.some((x) => x > 100) || p.reduce((a, b) => a + b, 0) !== 100) {
    fail('feasibility', 'The five sustainability percentages must add up to exactly 100%');
  } else {
    v.feasibility = { environmental: p[0], human: p[1], cultural: p[2], social: p[3], economic: p[4] };
  }

  // previous grants
  v.receivedSupport = oneOf('receivedSupport', 'Previous grants / support answer', ['Yes', 'No']);
  if (v.receivedSupport === 'Yes') {
    const desc = str(body.grantDescription);
    const agency = str(body.grantAgency);
    const amount = Number(body.grantAmount);
    const year = Number(body.grantYear);
    const thisYear = new Date().getFullYear();
    if (!desc) fail('grantDescription', 'Please provide a brief description');
    else if (desc.length > 350 || wordCount(desc) > 50) fail('grantDescription', 'Description: maximum 50 words / 350 characters');
    if (!agency) fail('grantAgency', 'Agency / Organisation / Scheme is required');
    else if (agency.length > 150) fail('grantAgency', 'Agency name must be at most 150 characters');
    if (!Number.isInteger(amount) || amount <= 1000 || amount > 99999999999) fail('grantAmount', 'Amount must be a whole number greater than 1,000');
    if (!Number.isInteger(year) || year < 1950 || year > thisYear) fail('grantYear', `Year must be between 1950 and ${thisYear}`);
    Object.assign(v, { grantDescription: desc, grantAgency: agency, grantAmount: amount, grantYear: year });
  }

  // declaration
  if (![true, 'on', 'true'].includes(body.declaration)) fail('declaration', 'You must accept the declaration');

  // cross-field checks
  if (v.leadEmail !== v.leadConfirmEmail) fail('leadConfirmEmail', 'Email addresses do not match');
  const seenEmail = new Set(), seenSid = new Set();
  const prefixes = ['lead', 'member2', 'member3'].concat(n === 4 ? ['member4'] : []);
  for (const pre of prefixes) {
    const e = v[`${pre}Email`], s = String(v[`${pre}StudentId`] ?? '').toLowerCase();
    if (e) { if (seenEmail.has(e)) fail(`${pre}Email`, 'Each team member needs a different email address'); seenEmail.add(e); }
    if (s) { if (seenSid.has(s)) fail(`${pre}StudentId`, 'Each team member needs a different student ID'); seenSid.add(s); }
  }

  return errors.length ? { ok: false, errors } : { ok: true, data: v };
}

function assertValid(raw) {
  const r = validateIdeaPayload(raw);
  if (r.ok) return r.data;
  const err = new Error(r.errors.slice(0, 3).map((e) => e.message).join(' • '));
  err.errors = r.errors;
  throw err;
}

// ───────────────────────── 4. FORM VALUES -> TABLE ROWS ─────────────────────────
const NUL = (x) => (x == null || x === '' ? null : x);

function buildRows(v) {
  const yes = v.receivedSupport === 'Yes';
  const idea = {
    team_name: v.teamName,
    theme: v.theme.key, theme_other: v.theme.other,
    number_of_members: v.numberOfMembers,
    college_name: v.leadCollege, college_city_village: NUL(v.collegeCityVillage),
    college_block: v.collegeBlock, college_district: v.collegeDistrict,
    college_state: v.collegeState, college_pincode: v.collegePincode,
    problem_statement: v.motivation, problem_validation: v.challengeImportance,
    pillar_environmental: v.feasibility.environmental, pillar_human: v.feasibility.human,
    pillar_cultural: v.feasibility.cultural, pillar_social: v.feasibility.social, pillar_economic: v.feasibility.economic,
    beneficiaries: v.beneficiaries, solution_description: v.solutionDescription, innovation: v.innovation,
    development_stage: v.developmentStage, technology_approach: v.technologyApproach,
    expected_impact: v.expectedImpact, team_skills: v.teamSkills, scalability_plan: v.challenge,
    received_support: yes,
    grant_description: yes ? v.grantDescription : null,
    grant_agency: yes ? v.grantAgency : null,
    grant_amount: yes ? v.grantAmount : null,
    grant_year: yes ? v.grantYear : null,
    declaration_accepted: true,
  };

  const member = (no, p, collegeKey, extra = {}) => ({
    member_no: no,
    first_name: v[`${p}FirstName`], last_name: v[`${p}LastName`], gender: v[`${p}Gender`],
    date_of_birth: v[`${p}Age`],
    qualification_level: v[`${p}QualificationLevel`].key, qualification_other: v[`${p}QualificationLevel`].other,
    degree: v[`${p}Degree`].key, degree_other: v[`${p}Degree`].other,
    year_semester: v[`${p}YearSemester`].key, year_semester_other: v[`${p}YearSemester`].other,
    institute_name: v[collegeKey], student_id: NUL(v[`${p}StudentId`]),
    email: v[`${p}Email`], mobile: v[`${p}Mobile`],
    ...extra,
  });
  const members = [
    member(1, 'lead', 'leadInstitute', {
      alternate_mobile: NUL(v.leadAlternateMobile), city_village: NUL(v.leadCityVillage),
      block: v.leadBlock, district: v.leadDistrict, state: v.leadState, pincode: v.leadPincode,
    }),
    member(2, 'member2', 'member2College'),
    member(3, 'member3', 'member3College'),
  ];
  if (v.numberOfMembers === 4) members.push(member(4, 'member4', 'member4College'));

  const faculty = {
    first_name: v.facultyFirstName, last_name: v.facultyLastName, gender: v.facultyGender,
    qualification: v.facultyQualification, designation: v.facultyDesignation, department: v.facultyDepartment,
    area_of_interest: v.facultyAreaOfInterest.key, area_of_interest_other: v.facultyAreaOfInterest.other,
    expertise: v.facultyExpertise, institute_name: v.facultyCollege, email: v.facultyEmail, mobile: v.facultyMobile,
  };
  return { idea, members, faculty };
}

// ───────────────────────── 5. TABLE ROWS -> FORM VALUES (edit-mode prefill) ─────────────────────────
function rowsToFormValues(idea, members, faculty) {
  const pick = (key, other) => (key === 'other' || key === 'others' ? { sel: key, custom: other } : { sel: key, custom: '' });
  const out = {
    teamName: idea.team_name, numberOfMembers: String(idea.number_of_members),
    leadCollege: idea.college_name, collegeCityVillage: idea.college_city_village,
    collegeBlock: idea.college_block, collegeDistrict: idea.college_district,
    collegeState: idea.college_state, collegePincode: idea.college_pincode,
    motivation: idea.problem_statement, challengeImportance: idea.problem_validation,
    beneficiaries: idea.beneficiaries, solutionDescription: idea.solution_description, innovation: idea.innovation,
    developmentStage: idea.development_stage, technologyApproach: idea.technology_approach,
    expectedImpact: idea.expected_impact, teamSkills: idea.team_skills, challenge: idea.scalability_plan,
    feasibility: `env-${idea.pillar_environmental},hum-${idea.pillar_human},cul-${idea.pillar_cultural},` +
      `social-${idea.pillar_social},eco-${idea.pillar_economic}`,
    receivedSupport: idea.received_support ? 'Yes' : 'No',
    grantDescription: idea.grant_description, grantAgency: idea.grant_agency,
    grantAmount: idea.grant_amount, grantYear: idea.grant_year,
  };
  const t = pick(idea.theme, idea.theme_other);
  out.theme = t.sel; out.customTheme = t.custom;

  for (const m of members) {
    const p = m.member_no === 1 ? 'lead' : `member${m.member_no}`;
    const customPrefix = m.member_no === 1 ? 'custom' : `${p}Custom`;
    const q = pick(m.qualification_level, m.qualification_other);
    const d = pick(m.degree, m.degree_other);
    const y = pick(m.year_semester, m.year_semester_other);
    Object.assign(out, {
      [`${p}FirstName`]: m.first_name, [`${p}LastName`]: m.last_name, [`${p}Gender`]: m.gender,
      [`${p}Age`]: m.date_of_birth,
      [`${p}QualificationLevel`]: q.sel, [`${customPrefix}Qualification`]: q.custom,
      [`${p}Degree`]: d.sel, [`${customPrefix}Degree`]: d.custom,
      [`${p}YearSemester`]: y.sel, [`${customPrefix}YearSemester`]: y.custom,
      [`${p}StudentId`]: m.student_id, [`${p}Email`]: m.email, [`${p}Mobile`]: m.mobile,
    });
    if (m.member_no === 1) {
      Object.assign(out, {
        leadInstitute: m.institute_name, leadConfirmEmail: m.email, leadAlternateMobile: m.alternate_mobile,
        leadCityVillage: m.city_village, leadBlock: m.block, leadDistrict: m.district,
        leadState: m.state, leadPincode: m.pincode,
      });
    } else {
      out[`${p}College`] = m.institute_name;
    }
  }

  const a = pick(faculty.area_of_interest, faculty.area_of_interest_other);
  Object.assign(out, {
    facultyFirstName: faculty.first_name, facultyLastName: faculty.last_name, facultyGender: faculty.gender,
    facultyQualification: faculty.qualification, facultyDesignation: faculty.designation,
    facultyDepartment: faculty.department, facultyAreaOfInterest: a.sel, customfacultyAreaOfInterest: a.custom,
    facultyExpertise: faculty.expertise, facultyCollege: faculty.institute_name,
    facultyEmail: faculty.email, facultyMobile: faculty.mobile,
  });
  return out;
}

// ───────────────────────── 6. SUPABASE HELPERS ─────────────────────────
function dbError(e) {
  if (e.code === '23505') return new Error('A record with these details already exists (duplicate team, email or student ID).');
  if (e.code === '42501') return new Error('The database refused this action (check your Supabase RLS policies).');
  return new Error(e.message || 'Database error');
}
const unwrap = ({ data, error }) => { if (error) throw dbError(error); return data; };

/**
 * Open form — no auth. Identify "this team's" idea by the lead's email address
 * (read from the form, falling back to the saved browser draft for page-load
 * prefill). Returns an idea id or null.
 */
async function findIdeaIdByLeadEmail() {
  let email = (document.querySelector('[name="leadEmail"]')?.value || '').trim().toLowerCase();
  if (!email) {
    try {
      const draft = JSON.parse(localStorage.getItem('utkarshIdeaSubmissionDraft') || '{}');
      email = String(draft.leadEmail || '').trim().toLowerCase();
    } catch (_) { /* ignore */ }
  }
  if (!email) return null;
  const row = unwrap(await _supabase.from(DB.members)
    .select('idea_id').eq('email', email).eq('member_no', 1).maybeSingle());
  return row ? row.idea_id : null;
}

const isEditable = (idea) => idea.is_editable === true;

const fetchIdeaById = async (id) =>
  unwrap(await _supabase.from(DB.ideas).select('*').eq('id', id).maybeSingle());
const fetchMembers = async (ideaId) =>
  unwrap(await _supabase.from(DB.members).select('*').eq('idea_id', ideaId).order('member_no'));
const fetchFaculty = async (ideaId) =>
  unwrap(await _supabase.from(DB.faculty).select('*').eq('idea_id', ideaId).maybeSingle());

async function insertChildren(ideaId, members, faculty) {
  unwrap(await _supabase.from(DB.members).insert(members.map((m) => ({ ...m, idea_id: ideaId }))));
  unwrap(await _supabase.from(DB.faculty).insert({ ...faculty, idea_id: ideaId }));
}

async function deleteChildren(ideaId) {
  unwrap(await _supabase.from(DB.members).delete().eq('idea_id', ideaId));
  unwrap(await _supabase.from(DB.faculty).delete().eq('idea_id', ideaId));
}

/** Optional concept note: uploads the file chosen in #conceptNoteFile, if any. */
async function uploadConceptNote(ideaId) {
  const input = document.getElementById('conceptNoteFile');
  const file = input && input.files && input.files[0];
  if (!file) return;
  if (!CONCEPT_MIMES.includes(file.type)) throw new Error('Concept note must be a PDF, DOC or DOCX file.');
  if (file.size > 1048576) throw new Error('Concept note file must be less than 1 MB.');
  const path = `${ideaId}/${Date.now()}-${file.name.replace(/[^\w.-]/g, '_')}`;
  const { error } = await _supabase.storage.from(DB.conceptBucket).upload(path, file, { contentType: file.type });
  if (error) throw new Error('Concept note upload failed: ' + error.message);
  unwrap(await _supabase.from(DB.ideas).update({
    concept_note_path: path, concept_note_name: file.name,
    concept_note_mime: file.type, concept_note_size: file.size,
  }).eq('id', ideaId));
}

// ───────────────────────── 7. PUBLIC API (what the page calls) ─────────────────────────
async function submitIdeaForm(data) {
  const v = assertValid(data);

  const rows = buildRows(v);
  // idea_code, status and is_editable come from column defaults (see supabase_direct_writes.sql)
  const idea = unwrap(await _supabase.from(DB.ideas)
    .insert(rows.idea).select().single());

  try {
    await insertChildren(idea.id, rows.members, rows.faculty);
    await uploadConceptNote(idea.id);
  } catch (err) {
    // best-effort rollback so a half-saved idea doesn't block the team from retrying
    await _supabase.from(DB.members).delete().eq('idea_id', idea.id);
    await _supabase.from(DB.faculty).delete().eq('idea_id', idea.id);
    await _supabase.from(DB.ideas).delete().eq('id', idea.id);
    throw err;
  }
  return { data: { id: idea.id, idea_code: idea.idea_code } };
}

async function updateIdeaForm(data) {
  const v = assertValid(data);
  const ideaId = await findIdeaIdByLeadEmail();
  const existing = ideaId ? await fetchIdeaById(ideaId) : null;
  if (!existing) throw new Error('No existing idea found for this team lead email.');
  if (!isEditable(existing)) throw new Error('Your idea has been assigned to an evaluator and can no longer be edited.');

  const rows = buildRows(v);
  const [oldMembers, oldFaculty] = await Promise.all([fetchMembers(existing.id), fetchFaculty(existing.id)]);

  unwrap(await _supabase.from(DB.ideas).update(rows.idea).eq('id', existing.id));

  // members + faculty are replaced wholesale; restore the old rows if the new insert fails
  try {
    await deleteChildren(existing.id);
    await insertChildren(existing.id, rows.members, rows.faculty);
    await uploadConceptNote(existing.id);
  } catch (err) {
    await _supabase.from(DB.members).delete().eq('idea_id', existing.id);
    await _supabase.from(DB.faculty).delete().eq('idea_id', existing.id);
    if (oldMembers && oldMembers.length) await _supabase.from(DB.members).insert(oldMembers);
    if (oldFaculty) await _supabase.from(DB.faculty).insert(oldFaculty);
    throw err;
  }
  return { data: { id: existing.id, idea_code: existing.idea_code } };
}

/** null = no idea yet (fresh submission). Otherwise the shape initFormMode() expects. */
async function loadIdeaForEdit() {
  const ideaId = await findIdeaIdByLeadEmail();
  const idea = ideaId ? await fetchIdeaById(ideaId) : null;
  if (!idea) return null;
  const [members, faculty] = await Promise.all([fetchMembers(idea.id), fetchFaculty(idea.id)]);
  return {
    isEditable: isEditable(idea),
    ideaCode: idea.idea_code || '',
    conceptNoteFileName: idea.concept_note_name || null,
    values: rowsToFormValues(idea, members, faculty || {}),
  };
}