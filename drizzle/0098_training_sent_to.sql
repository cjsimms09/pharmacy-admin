-- The address a training email actually went to.
--
-- The owner: "changed an employees email and not sure training email are being sent to updated
-- email." He could not be sure and neither could the site: `sent_at` recorded that a message went,
-- and nothing recorded where. The send reads the person's address live, so it has always used the
-- current one — but "the code does the right thing" is not evidence, and evidence is what he asked
-- for. Written on every send from here.
ALTER TABLE training_assignments ADD COLUMN sent_to text;
