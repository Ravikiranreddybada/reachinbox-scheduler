/**
 * Creates a disposable Ethereal SMTP account and prints the .env lines.
 * Ethereal never delivers mail; messages are viewable at https://ethereal.email.
 */
import nodemailer from 'nodemailer';

nodemailer
  .createTestAccount()
  .then((account) => {
    console.log(`ETHEREAL_HOST=${account.smtp.host}`);
    console.log(`ETHEREAL_PORT=${account.smtp.port}`);
    console.log(`ETHEREAL_USER=${account.user}`);
    console.log(`ETHEREAL_PASSWORD=${account.pass}`);
  })
  .catch((error) => {
    console.error('Could not create an Ethereal account:', error.message);
    process.exit(1);
  });
