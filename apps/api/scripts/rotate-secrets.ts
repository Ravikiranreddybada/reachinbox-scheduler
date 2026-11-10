import { decryptSecret, encryptSecret, isCurrentCiphertext } from '../src/lib/crypto.js';
import { prisma } from '../src/lib/infra.js';
import { logger } from '../src/lib/logger.js';

/**
 * Key rotation. Put the new key in DATA_ENCRYPTION_KEY and the old one in
 * DATA_ENCRYPTION_KEY_PREVIOUS, then run this once. Every stored secret is
 * re-encrypted with the new key. Safe to repeat: current values are skipped.
 */
async function rotate() {
  let rotated = 0;
  const reencrypt = (value: string | null) =>
    value && !isCurrentCiphertext(value) ? encryptSecret(decryptSecret(value)) : null;

  for (const row of await prisma.slackConnection.findMany()) {
    const webhookUrl = reencrypt(row.webhookUrl);
    const accessToken = reencrypt(row.accessToken);
    if (!webhookUrl && !accessToken) continue;
    await prisma.slackConnection.update({
      where: { id: row.id },
      data: { ...(webhookUrl ? { webhookUrl } : {}), ...(accessToken ? { accessToken } : {}) },
    });
    rotated += 1;
  }
  for (const row of await prisma.sender.findMany({ where: { smtpPassword: { not: null } } })) {
    const smtpPassword = reencrypt(row.smtpPassword);
    if (!smtpPassword) continue;
    await prisma.sender.update({ where: { id: row.id }, data: { smtpPassword } });
    rotated += 1;
  }
  logger.info({ event: 'secrets.rotated', rotated });
}

rotate()
  .then(() => 0)
  .catch((error) => {
    logger.error({ event: 'secrets.rotate_failed', err: error });
    return 1;
  })
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  });
