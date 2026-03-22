// Logger structuré LocalBot
// Production : JSON sur process.stdout.write
// Développement : format coloré sur stderr + JSON sur console.log (compatibilité tests)

function isProd() {
  return process.env.NODE_ENV === 'production';
}

function buildLogObj(level, event, data) {
  return { timestamp: new Date().toISOString(), level, event, ...data };
}

function devColor(level) {
  if (level === 'WARN')  return '\x1b[33m'; // jaune
  if (level === 'ERROR') return '\x1b[31m'; // rouge
  return '\x1b[37m';                        // blanc (INFO)
}

function writeLog(level, event, data) {
  const logObj = buildLogObj(level, event, data);
  const json   = JSON.stringify(logObj);

  if (isProd()) {
    process.stdout.write(json + '\n');
  } else {
    // Format coloré vers stderr pour le développeur
    const time  = new Date().toLocaleTimeString('fr-FR');
    const color = devColor(level);
    process.stderr.write(`${color}[${time}] ${level} ${event}\x1b[0m ${JSON.stringify(data)}\n`);
    // JSON vers console.log/warn/error pour la capture dans les tests
    if (level === 'WARN')  console.warn(json);
    else if (level === 'ERROR') console.error(json);
    else console.log(json);
  }
}

const logger = {
  /**
   * @param {string} event
   * @param {object} [data={}]
   */
  info(event, data = {}) {
    writeLog('INFO', event, data);
  },

  /**
   * @param {string} event
   * @param {object} [data={}]
   */
  warn(event, data = {}) {
    writeLog('WARN', event, data);
  },

  /**
   * @param {string} event
   * @param {Error|string} err
   * @param {object} [data={}]
   */
  error(event, err, data = {}) {
    const errorInfo = err instanceof Error
      ? { error: err.message, stack: err.stack }
      : { error: String(err) };
    writeLog('ERROR', event, { ...errorInfo, ...data });
  },
};

module.exports = logger;
