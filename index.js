const removeMd = require('remove-markdown');

async function responsesData(method, options) {
  function* paginationResponses(request, fromPage, toPage) {
    for (let page = fromPage; page <= toPage; page += 1) {
      yield request.method({ ...request.options, page });
    }
  }

  function* matches(regex, text) {
    let match = null;
    do {
      match = regex.exec(text);
      if (match) yield match;
    } while (match);
  }

  const optionsWithPagination = { ...options, per_page: 100 };
  const request = { method, options: optionsWithPagination };

  const firstResponse = await method(optionsWithPagination);
  const regExp = /<(?<link>.+?)>;\srel="(?<rel>.+?)"/g;

  const links = Object.fromEntries([...matches(regExp, firstResponse.headers.link)]
    .map(({ groups: { rel, link } }) => [rel, link]));

  const { nextPage, lastPage } = Object.fromEntries(Object.entries(links)
    .map(([rel, link]) => [`${rel}Page`, Number(new URL(link).searchParams.get('page'))]));

  const remainingResponse = nextPage && lastPage
    ? await Promise.all([...paginationResponses(request, nextPage, lastPage)]) : [];

  const responses = [firstResponse, ...remainingResponse];
  const uniqueResponsesData = responses.flatMap(({ data }) => data)
    .filter((item1, pos, arr) => arr.findIndex((item2) => item2.id === item1.id) === pos);

  return uniqueResponsesData;
}

class KnowledgeBase {
  constructor() { this.workers = []; }

  async init(github, repository) {
    const owner = repository.owner.login;
    const repo = repository.name;

    const getAction = (message, isMessageFromCreator) => {
      const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);
      return {
        isMessageFromCreator,
        timestamp: +new Date(message.createdAt),
        text: capitalize(removeMd(message.body.replace(/`{3}.*?`{3}/gs, ''))
          .replace(/\w*:?\/\/([\w_-]+(?:(?:\.[\w_-]+)+))([.,:\w?@#%&/^+=~-]*[\w?@#%&/^+=~-])?/g, '')
          .replace(/(?:\\(?:n|r|t|0)|[^a-zA-ZÀ-ÖØ-öø-ÿ0-9_.,¿?¡!'‘’“”"@#$%&+=-])+,*/g, ' ')
          .replace(/\s+([_.,¿?¡!'‘’“”"@#$%&+=-][^a-zA-ZÀ-ÖØ-öø-ÿ0-9])/g, '$1')
          .replace(/([_.,¿?¡!'‘’“”"@#$%&+=-])\1+/g, '$1')
          .replace(/(?<=\S)['‘“"@#&=-]/g, ' ')
          .replace(/\s+/g, ' ')
          .replace(/^\s+|\s+$/g, '')
          .replace(/(?<=[^.,?!])$/, '.')
          .replace(/,([^\s\d])/g, ', $1')
          .replace(/\s+([.,?!])$/, '$1')),
      };
    };

    const issues = await Promise.all(await responsesData(github.issues.listForRepo, { owner, repo })
      .then((repositoryIssues) => repositoryIssues.map((repoIssue) => new Promise((resolve) => {
        responsesData(github.issues.listComments, { owner, repo, issue_number: repoIssue.number })
          .then((comments) => {
            const { user, body, created_at: createdAt } = repoIssue;
            const mappedComments = comments.map((comment) => ({
              user: comment.user, body: comment.body, createdAt: comment.created_at,
            }));
            resolve({ user, messages: [{ user, body, createdAt }, ...mappedComments] });
          });
      }))));

    issues.forEach((issue) => {
      const { user: creator, messages } = issue;

      messages.forEach((message) => {
        const { user } = message;
        const { id } = user;

        if (user.type === 'User') {
          const existingWorker = this.workers.find((worker) => worker.id === id);
          const isMessageFromCreator = id === creator.id;

          if (!existingWorker) {
            this.workers.push({
              id, name: user.login, actions: [getAction(message, isMessageFromCreator)],
            });
          } else existingWorker.actions.push(getAction(message, isMessageFromCreator));
        }
      });
    });

    return this;
  }

  getTerms() {
    const regExp = /(?<=^|\s)['‘“"¿?¡!]*(?<term>.*?)[?!'’”".,-]*(?=\s|$)/g;
    return this.workers.flatMap(({ actions }) => actions.map(({ text }) => text))
      .flatMap((text) => [...text.matchAll(regExp)].map(({ groups }) => groups.term.toLowerCase()));
  }

  getLowestActionTimestamp(term) {
    return Math.min(...this.workers
      .flatMap((worker) => this.constructor.getWorkerActionsWithTerm(worker, term))
      .map((action) => action.timestamp));
  }

  static getWorkerActionsWithTerm(worker, term) {
    const regExp = new RegExp(`(?<=^|\\s)['‘“"¿?¡!]*${term}[?!'’”".,-]*(?=\\s|$)`, 'i');
    return worker.actions.filter((action) => regExp.test(action.text));
  }
}

function whoKnows(term, knowledgeBase) {
  const lowestActionTimestamp = knowledgeBase.getLowestActionTimestamp(term);
  const now = +new Date();

  let suitableWorkerScore = 0;
  let suitableWorker = null;

  knowledgeBase.workers.forEach((worker) => {
    const workerActionsWithTerm = KnowledgeBase.getWorkerActionsWithTerm(worker, term);
    let score = 0;

    workerActionsWithTerm.forEach((action) => {
      score += action.isMessageFromCreator ? 0 : 0.5;
      score += 1 - (now - action.timestamp) / (now - lowestActionTimestamp);
    });

    if (score > suitableWorkerScore) {
      suitableWorkerScore = score;
      suitableWorker = worker;
    }
  });

  return suitableWorker;
}

function howManyKnows(term, knowledgeBase) {
  let workersWithKnowledge = 0;
  let totalOfSpecialization = 0;

  knowledgeBase.workers.forEach((worker) => {
    const workerActionsWithTerm = KnowledgeBase.getWorkerActionsWithTerm(worker, term);

    if (workerActionsWithTerm.length) {
      workersWithKnowledge += 1;
      totalOfSpecialization += workerActionsWithTerm.length / worker.actions.length;
    }
  });

  const proportionOfKnowledge = workersWithKnowledge / knowledgeBase.workers.length;
  const levelOfSpecialization = totalOfSpecialization / knowledgeBase.workers.length;

  return { proportionOfKnowledge, levelOfSpecialization };
}

function mostUsedTerms(knowledgeBase) {
  const termList = knowledgeBase.getTerms();

  const frequencyOfTerms = termList.reduce((termAccumulator, term) => {
    const terms = termAccumulator;
    if (term.length !== 0) {
      terms[term] = Object.prototype.hasOwnProperty.call(terms, term)
        ? terms[term] + 1 : 1;
    }
    return terms;
  }, {});

  const comparator = (a, b) => {
    if (a.amount > b.amount) return -1;
    if (a.amount < b.amount) return 1;
    if (a.term < b.term) return -1;
    if (a.term > b.term) return 1;
    return 0;
  };

  const mostFrequentTerms = Object.entries(frequencyOfTerms)
    .map(([term, amount]) => ({ term, amount }))
    .sort(comparator)
    .map(({ term }) => term);

  return mostFrequentTerms;
}

const toPercentage = (number) => (number * 100).toFixed(2);

module.exports = (app) => {
  app.on('issue_comment.created', async (context) => {
    const { github, payload } = context;
    const { comment, sender, repository } = payload;
    const botName = process.env.BOT_NAME;

    const question = new RegExp(`@${botName}\\s+(?<code>\\w+)(?:\\s+(?<term>\\S+))?`, 'i')
      .exec(comment.body);

    if (question) {
      const knowledgeBase = await new KnowledgeBase().init(github, repository);
      const { groups: { code, term } } = question;
      let parameters;

      switch (code.toUpperCase()) {
        case 'QUEMSABE': {
          const whoKnowsResult = whoKnows(term, knowledgeBase);
          parameters = context.issue({
            body: `@${sender.login}, `
              + `${whoKnowsResult ? `quem sabe é: @${whoKnowsResult.name}.` : 'ninguém.'}`,
          });
          break;
        }
        case 'QUANTOSSABEM': {
          const howManyKnowsResult = howManyKnows(term, knowledgeBase);
          parameters = context.issue({
            body: `@${sender.login},\n`
              + `Proporção: ${toPercentage(
                howManyKnowsResult.proportionOfKnowledge,
              )}%\n`
              + `Especialização: ${toPercentage(
                howManyKnowsResult.levelOfSpecialization,
              )}%`,
          });
          break;
        }
        case 'SOBREOQUESABEM': {
          const mostUsedTermsResult = mostUsedTerms(knowledgeBase);
          parameters = context.issue({
            body: `@${sender.login},\n`
              + `${mostUsedTermsResult.slice(0, 20).map((t) => `- ${t}`).join('\n')}`,
          });
          break;
        }
        default: { break; }
      }

      return github.issues.createComment(parameters);
    }

    return null;
  });
};
