import { Application, GitHubAPI } from 'probot';
import removeMd from 'remove-markdown';

import {
  Worker,
  TermAmount,
  FrequencyOfTerms,
  ListForRepoParams,
  Request,
  RequestMethod,
  ListCommentsParams,
  ListForRepoResponseItem,
  ListCommentsResponseItem,
  Identifiable,
  Issue,
  Message,
  Links,
  Repository,
} from './types';


/**
 * @param method A Ocktokit GET request
 * @param options Options of the Ocktokit GET request
 */
async function responsesData<P, R extends Identifiable>(method: RequestMethod<P, R>, options: P) {
  function* paginationResponses(request: Request<RequestMethod<P, R>, P>,
    fromPage: number, toPage: number) {
    for (let page = fromPage; page <= toPage; page += 1) {
      yield request.method({ ...request.options, page });
    }
  }

  function* matches(regex: RegExp, text: string) {
    let match = null;
    do {
      match = regex.exec(text);
      if (match) yield match;
    } while (match);
  }

  const optionsWithPagination = { ...options, per_page: 100 };
  const request = { method, options: optionsWithPagination };

  const firstResponse = await method(optionsWithPagination);
  /**
   * Captures the relationship between pagination and your link
   */
  const regex = /<(?<link>.+?)>;\srel="(?<rel>.+?)"/g;

  const links: Links = Object.fromEntries([...matches(regex, firstResponse.headers.link)]
    .map(({ groups }) => [groups?.rel, groups?.link]));

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
  workers: Worker[];

  constructor() { this.workers = []; }

  async init(github: GitHubAPI, repository: Repository) {
    const owner = repository.owner.login;
    const repo = repository.name;

    const getAction = (message: Message, isMessageFromCreator: boolean) => {
      const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
      return {
        isMessageFromCreator,
        /**
         * Timestamp from ISO 8601 format (Complete date plus hours and minutes)
         */
        timestamp: +new Date(message.createdAt),
        /**
         * Text without Markdown notation, links and remaining characters and spaces
         */
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

    /**
     * Issues obtained by requesting all issues in the
     * repository and subsequently all issue comments
     */
    const issues = await Promise.all(
      await responsesData<ListForRepoParams,
        ListForRepoResponseItem>(github.issues.listForRepo, { owner, repo })
        .then((repositoryIssues) => repositoryIssues.map(
          (repoIssue) => new Promise<Issue>((resolve) => {
            responsesData<ListCommentsParams, ListCommentsResponseItem>(github.issues.listComments,
              { owner, repo, issue_number: repoIssue.number })
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
    /**
     * Captures the term by discarding special characters on both sides
     */
    const regex = /(?<=^|\s)['‘“"¿?¡!]*(?<term>.*?)[?!'’”".,-]*(?=\s|$)/g;
    return this.workers.flatMap(({ actions }) => actions.map(({ text }) => text))
      .flatMap((text) => [...text.matchAll(regex)].map(({ groups }) => groups?.term.toLowerCase()));
  }

  getLowestActionTimestamp(term: string) {
    return Math.min(...this.workers
      .flatMap((worker) => KnowledgeBase.getWorkerActionsWithTerm(worker, term))
      .map((action) => action.timestamp));
  }

  static getWorkerActionsWithTerm(worker: Worker, term: string) {
    /**
     * Captures the term by discarding special characters on both sides
     */
    const regex = new RegExp(`(?<=^|\\s)['‘“"¿?¡!]*${term}[?!'’”".,-]*(?=\\s|$)`, 'i');
    return worker.actions.filter((action) => regex.test(action.text));
  }
}

function whoKnows(term: string, knowledgeBase: KnowledgeBase) {
  /**
   * The current timestamp
   */
  const now = +new Date();
  const lowestActionTimestamp = knowledgeBase.getLowestActionTimestamp(term);

  let suitableWorkerScore = 0;
  let suitableWorker: Worker | undefined;

  knowledgeBase.workers.forEach((worker: Worker) => {
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

function howManyKnows(term: string, knowledgeBase: KnowledgeBase) {
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

function mostUsedTerms(knowledgeBase: KnowledgeBase) {
  const termList = knowledgeBase.getTerms();

  const frequencyOfTerms = termList.reduce<FrequencyOfTerms>((termAccumulator, term) => {
    const terms = termAccumulator;
    if (term && term.length !== 0) {
      terms[term] = Object.prototype.hasOwnProperty.call(terms, term)
        ? terms[term] + 1 : 1;
    }
    return terms;
  }, {});

  /**
   * Sort according to quantity, using alphabetical order as tiebreaker
   */
  const comparator = (a: TermAmount, b: TermAmount) => {
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

const toPercentage = (number: number) => (number * 100).toFixed(2);

module.exports = (app: Application) => {
  app.on('issue_comment.created', async (context) => {
    const { github, payload } = context;
    const { comment, sender, repository } = payload;
    const botName = process.env.BOT_NAME;

    /**
     * Verifica o padrão de mensagem para ativar as funções do robô e
     * captura o identificador da função e o termo a ser usado.
     */
    const question = new RegExp(`@${botName}\\s+(?<code>\\w+)(?:\\s+(?<term>\\S+))?`, 'i')
      .exec(comment.body);

    if (question) {
      const knowledgeBase = await new KnowledgeBase().init(github, repository);
      const { code, term } = question.groups ?? { code: '', term: '' };

      let parameters;

      const checkTerm = (term: string) => {
        if (!term) {
          parameters = context.issue({
            body: `@${sender.login}, termo não informado`
          });
          return false;
        }
        return true;
      }

      switch (code.toUpperCase()) {
        case 'QUEMSABE': {
          if (!checkTerm(term)) break;
          const whoKnowsResult = whoKnows(term, knowledgeBase);
          parameters = context.issue({
            body: `@${sender.login}, `
              + `${whoKnowsResult ? `quem sabe é: @${whoKnowsResult.name}.` : 'ninguém.'}`,
          });
          break;
        }
        case 'QUANTOSSABEM': {
          if (!checkTerm(term)) break;
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

      github.issues.createComment(parameters);
    }
  });
};
