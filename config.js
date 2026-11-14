/* Pilot settings for the serverless site. Fill these in after creating the Google Forms (see docs/pilot.md).
   Leave a value empty to turn that part off; progress then stays in the student's browser only. */
window.R2C_CONFIG = {
  // Activity log: one Google Form with six short-answer questions. action = the form's .../formResponse URL,
  // fields = the entry.NNN id of each question (Get pre-filled link in Google Forms shows them).
  log: {
    action: "",
    fields: { pid: "", code: "", kind: "", milestone: "", detail: "", at: "" }
  },
  // AI-free pre/post tests (Google Forms quizzes). {pid} and {code} are replaced with the student's values.
  preTest: "",
  postTest: "",
  // Where students and parents read how their data is used (pilot consent form).
  privacy: ""
};
