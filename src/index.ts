import { Application, GitHubAPI } from "probot";
import express from 'express'
import removeMd from "remove-markdown";
import markdownTable from "markdown-table";

import wordCloud from "./wordCloud";

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
  Config,
  Question,
  Messages,
  WorkerScore,
  WorkersKnowledge,
} from "./types";

/**
 * @param method A Ocktokit GET request
 * @param options Options of the Ocktokit GET request
 */
async function responsesData<P, R extends Identifiable>(
  method: RequestMethod<P, R>,
  options: P
) {
  function* paginationResponses(
    request: Request<RequestMethod<P, R>, P>,
    fromPage: number,
    toPage: number
  ) {
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

  const links: Links = Object.fromEntries(
    [...matches(regex, firstResponse.headers.link)].map(({ groups }) => [
      groups?.rel,
      groups?.link,
    ])
  );

  const { nextPage, lastPage } = Object.fromEntries(
    Object.entries(links).map(([rel, link]) => [
      `${rel}Page`,
      Number(new URL(link).searchParams.get("page")),
    ])
  );

  const remainingResponse =
    nextPage && lastPage
      ? await Promise.all([...paginationResponses(request, nextPage, lastPage)])
      : [];

  const responses = [firstResponse, ...remainingResponse];
  const uniqueResponsesData = responses
    .flatMap(({ data }) => data)
    .filter(
      (item1, pos, arr) =>
        arr.findIndex((item2) => item2.id === item1.id) === pos
    );

  return uniqueResponsesData;
}

class KnowledgeBase {
  workers: Worker[];

  constructor() {
    this.workers = [];
  }

  async init(github: GitHubAPI, repository: Repository) {
    const owner = repository.owner.login;
    const repo = repository.name;

    const getAction = (message: Message, isMessageFromCreator: boolean) => {
      const capitalize = (text: string) =>
        text.charAt(0).toUpperCase() + text.slice(1);
      return {
        isMessageFromCreator,
        /**
         * Timestamp from ISO 8601 format (Complete date plus hours and minutes)
         */
        timestamp: +new Date(message.createdAt),
        /**
         * Text without Markdown notation, links and remaining characters and spaces
         */
        text: capitalize(
          removeMd(message.body.replace(/`{3}.*?`{3}/gs, ""))
            .replace(
              /\w*:?\/\/([\w_-]+(?:(?:\.[\w_-]+)+))([.,:\w?@#%&/^+=~-]*[\w?@#%&/^+=~-])?/g,
              ""
            )
            .replace(
              /(?:\\(?:n|r|t|0)|[^a-zA-ZÀ-ÖØ-öø-ÿ0-9_.,¿?¡!'‘’“”"@#$%&+=-])+,*/g,
              " "
            )
            .replace(/\s+([_.,¿?¡!'‘’“”"@#$%&+=-][^a-zA-ZÀ-ÖØ-öø-ÿ0-9])/g, "$1")
            .replace(/([_.,¿?¡!'‘’“”"@#$%&+=-])\1+/g, "$1")
            .replace(/(?<=\S)['‘“"@#&=-]/g, " ")
            .replace(/\s+/g, " ")
            .replace(/^\s+|\s+$/g, "")
            .replace(/(?<=[^.,?!])$/, ".")
            .replace(/,([^\s\d])/g, ", $1")
            .replace(/\s+([.,?!])$/, "$1")
        ),
      };
    };

    /**
     * Issues obtained by requesting all issues in the
     * repository and subsequently all issue comments
     */
    const issues = await Promise.all(
      await responsesData<ListForRepoParams, ListForRepoResponseItem>(
        github.issues.listForRepo,
        { owner, repo }
      ).then((repositoryIssues) =>
        repositoryIssues.map(
          (repoIssue) =>
            new Promise<Issue>((resolve) => {
              responsesData<ListCommentsParams, ListCommentsResponseItem>(
                github.issues.listComments,
                { owner, repo, issue_number: repoIssue.number }
              ).then((comments) => {
                const { user, body, created_at: createdAt } = repoIssue;
                const mappedComments = comments.map((comment) => ({
                  user: comment.user,
                  body: comment.body,
                  createdAt: comment.created_at,
                }));
                resolve({
                  user,
                  messages: [{ user, body, createdAt }, ...mappedComments],
                });
              });
            })
        )
      )
    );

    issues.forEach((issue) => {
      const { user: creator, messages } = issue;

      messages.forEach((message) => {
        const { user } = message;
        const { id } = user;

        if (user.type === "User") {
          const existingWorker = this.workers.find(
            (worker) => worker.id === id
          );
          const isMessageFromCreator = id === creator.id;

          if (!existingWorker) {
            this.workers.push({
              id,
              name: user.login,
              actions: [getAction(message, isMessageFromCreator)],
            });
          } else
            existingWorker.actions.push(
              getAction(message, isMessageFromCreator)
            );
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
    return this.workers
      .flatMap(({ actions }) => actions.map(({ text }) => text))
      .flatMap((text) =>
        [...text.matchAll(regex)].map(({ groups }) =>
          groups?.term.toLowerCase()
        )
      );
  }

  getLowestActionTimestamp(term: string) {
    return Math.min(
      ...this.workers
        .flatMap((worker) =>
          KnowledgeBase.getWorkerActionsWithTerm(worker, term)
        )
        .map((action) => action.timestamp)
    );
  }

  static getWorkerActionsWithTerm(worker: Worker, term: string) {
    /**
     * Captures the term by discarding special characters on both sides
     */
    const regex = new RegExp(
      `(?<=^|\\s)['‘“"¿?¡!]*${term}[?!'’”".,-]*(?=\\s|$)`,
      "i"
    );
    return worker.actions.filter((action) => regex.test(action.text));
  }
}

function whoKnows(term: string, knowledgeBase: KnowledgeBase) {
  /**
   * The current timestamp
   */
  const now = +new Date();
  const lowestActionTimestamp = knowledgeBase.getLowestActionTimestamp(term);

  const workersScore = knowledgeBase.workers.map((worker: Worker) => {
    const workerActionsWithTerm = KnowledgeBase.getWorkerActionsWithTerm(
      worker,
      term
    );

    const score = workerActionsWithTerm.reduce((workerScore, action) => {
      workerScore += action.isMessageFromCreator ? 0 : 0.5;
      return workerScore += 1 - (now - action.timestamp) / (now - lowestActionTimestamp);
    }, 0);

    return { worker, score }
  });

  return workersScore;
}

function howManyKnows(term: string, knowledgeBase: KnowledgeBase) {
  let workersWithKnowledge = 0;
  let totalOfSpecialization = 0;

  const workersKnowledge = knowledgeBase.workers.map((worker) => {
    const workerActionsWithTerm = KnowledgeBase.getWorkerActionsWithTerm(
      worker,
      term
    );

    if (workerActionsWithTerm.length) {
      workersWithKnowledge += 1;
      totalOfSpecialization += workerActionsWithTerm.length / worker.actions.length;
    }

    return {
      name: worker.name,
      actions: {
        withTerm: workerActionsWithTerm.length,
        total: worker.actions.length
      }
    };
  });




  const proportionOfKnowledge =
    workersWithKnowledge / knowledgeBase.workers.length;
  const levelOfSpecialization =
    totalOfSpecialization / knowledgeBase.workers.length;

  return { workersKnowledge, proportionOfKnowledge, levelOfSpecialization };
}

async function mostUsedTerms(knowledgeBase: KnowledgeBase) {
  const termList = knowledgeBase.getTerms();

  const frequencyOfTerms = termList.reduce<FrequencyOfTerms>(
    (termAccumulator, term) => {
      const terms = termAccumulator;
      if (term && term.length !== 0) {
        terms[term] = Object.prototype.hasOwnProperty.call(terms, term)
          ? terms[term] + 1
          : 1;
      }
      return terms;
    },
    {}
  );

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
    .sort(comparator);

  return mostFrequentTerms;
}

function getExplainWhoKnows(explainLevel: string, workersScore: WorkerScore[]) {
  switch (explainLevel) {
    case '1': {
      const getFormatedString = ({ worker, score }: WorkerScore) => `${worker.name}: ${score.toFixed(2)}`

      const host = process.env.HOST;
      const allWorkersScore = workersScore.map(getFormatedString).join(',')

      return `\n\nPara cada mensagem contendo o termo enviado, o trabalhador recebe em sua pontuação o \
      acréscimo de 1 ponto subtraído da razão entre a diferença do momento atual e o momento no qual a \
      mensagem foi realizada sobre a diferença do momento atual e a mensagem mais antiga do usuário que \
      contem o termo.</br> Para ver a lista completa da relação entre as pessoas e sua pontuação clique \
      [aqui](${host}/questions/${Question.WHO_KNOWS}/list?workers=${encodeURIComponent(allWorkersScore)})`
    }
    default: {
      return ""
    }
  }
}

function getExplainHowManyKnows(explainLevel: string, workersKnowledge: WorkersKnowledge[]) {
  switch (explainLevel) {
    case '1': {
      const workersWithTerm = workersKnowledge.filter(worker => worker.actions.withTerm !== 0).length;
      const actionsWithTerm = workersKnowledge.reduce((sum, worker) => sum + worker.actions.withTerm, 0);
      const totalActions = workersKnowledge.reduce((sum, worker) => sum + worker.actions.total, 0);

      return `\n\nQuantidade de pessoas que comentaram nas issues do repositório = ${workersKnowledge.length}\n` +
        `Pessoas que comentaram o termo = ${workersWithTerm}\n` +
        `Proporção de pessoas que conhecem o termo = ` +
        `${workersWithTerm} / ${workersKnowledge.length} = ${toPercentage(workersWithTerm / workersKnowledge.length)}%\n\n`
    }
    default: {
      return ""
    }
  }
}

function getExplainWhatTheyKnows(explainLevel: string, termsAmount: TermAmount[]) {
  switch (explainLevel) {
    case '1': {
      const mostUsedTerms = markdownTable([["Termos", "Quantidade"],
      ...termsAmount.slice(0, 20).map(({ term, amount }) => [term, amount.toString()])], { align: ['l', 'c'] });

      return `\n\nForam coletados todas os comentários das issues desse repositório e os termos foram \
      extraidos e contabilizados resultando em\n${mostUsedTerms}`
    }
    default: {
      return ""
    }
  }
}

const toPercentage = (number: number) => (number * 100).toFixed(2);

const messages: Messages = {
  [Question.WHO_KNOWS](user, term, worker) {
    return `${user}, das pessoas que participaram de alguma issue neste repositório, ` +
      `quem mais sabe sobre "${term}" é ${worker}`
  },
  [Question.HOW_MANY_KNOWS](user, term, proportionOfKnowledge, levelOfSpecialization) {
    return `${user}, ${toPercentage(proportionOfKnowledge)}% ` +
      `das pessoas que participaram de alguma issue neste repositório sabem sobre "${term}". ` +
      `O nível de especialização da rede dos participantes das issues a respeito desse termo é ` +
      `${toPercentage(levelOfSpecialization)}%.`
  },
  [Question.WHAT_THEY_KNOWS](user, terms) {
    const host = process.env.HOST;
    const termsParam = terms.join(',');

    return `${user}\n` + `![Termos: ${termsParam}](${host}/questions/${Question.WHAT_THEY_KNOWS}/image?terms=${termsParam})`
  }
}

module.exports = (app: Application) => {
  const questions = app.route(`/questions`)

  questions.use(require('express').static('public'))

  questions.get(`/${Question.WHO_KNOWS}/list`, (req: express.Request, res: express.Response) => {
    const workers = req.params.workers.split(',') ?? [];
    const workersList = workers.map((worker) => `<ul>${worker}</ul>`).join('\n')

    res.set('Content-Type', 'text/html');
    res.send(Buffer.from(`<ol>${workersList}</ol>`));
  })

  questions.get(`/${Question.HOW_MANY_KNOWS}/list`, (req: express.Request, res: express.Response) => {
    const workers = req.params.workers.split(',') ?? [];
    const workersList = workers.map((worker) => `<ul>${worker}</ul>`).join('\n')

    res.set('Content-Type', 'text/html');
    res.send(Buffer.from(`<ol>${workersList}</ol>`));
  })

  questions.get(`/${Question.WHAT_THEY_KNOWS}/list`, (req: express.Request, res: express.Response) => {
    const terms = req.params.terms.split(',') ?? [];
    const termsList = terms.map((term) => `<li>${term}</li>`).join('\n')

    res.set('Content-Type', 'text/html');
    res.send(Buffer.from(`<ol>${termsList}</ol>`));
  })

  questions.get(`/${Question.WHAT_THEY_KNOWS}/image`, async (req: express.Request, res: express.Response) => {
    const terms = req.params.terms.split(',') ?? [];

    res.set('Content-Type', 'image/svg+xml');
    res.send(Buffer.from(await wordCloud(terms)));
  })

  app.on("issue_comment.created", async (context) => {
    const config = (await context.config('woko-b.yml')) as Config
    const { github, payload } = context;
    const { comment, sender, repository } = payload;
    const botName = process.env.BOT_NAME;
    const { keywords } = config;

    context.log(keywords?.whoKnows ?? "QUEMSABE");

    /**
     * Verifica o padrão de mensagem para ativar as funções do robô e
     * captura o identificador da função e o termo a ser usado.
     */
    const question = new RegExp(
      `@${botName}\\s+(?:${keywords?.explain ?? "explique"}(?<explainLevel>\\d+)\\s)?(?<code>\\w+)(?:\\s+(?<term>\\S+))?`,
      "i"
    ).exec(comment.body);

    if (question) {
      const knowledgeBase = await new KnowledgeBase().init(github, repository);
      const { explainLevel, code, term } = question.groups ?? { code: "", term: "" };

      let parameters;

      const checkTerm = (term: string) => {
        if (!term) {
          parameters = context.issue({
            body: `@${sender.login}, termo não informado`,
          });
          return false;
        }
        return true;
      };

      switch (code.toUpperCase()) {
        case keywords?.whoKnows?.toUpperCase() ?? "QUEMSABE": {
          if (!checkTerm(term)) break;
          const whoKnowsResult = whoKnows(term, knowledgeBase);

          const explain = getExplainWhoKnows(explainLevel, whoKnowsResult);
          const greatest = whoKnowsResult.reduce((suitableWorker, currentWorker) => currentWorker.score > suitableWorker.score ? currentWorker : suitableWorker);
          const suitable = greatest.score != 0 ? greatest : null
          const result = messages[Question.WHO_KNOWS](sender.login, term, suitable?.worker?.name ?? 'ninguém');

          parameters = context.issue({
            body: result + explain
          });
          break;
        }
        case keywords?.howManyKnows?.toUpperCase() ?? "QUANTOSSABEM": {
          if (!checkTerm(term)) break;
          const { workersKnowledge, proportionOfKnowledge, levelOfSpecialization } = howManyKnows(term, knowledgeBase);

          const explain = getExplainHowManyKnows(explainLevel, workersKnowledge)
          const result = messages[Question.HOW_MANY_KNOWS](sender.login, term, proportionOfKnowledge, levelOfSpecialization);

          parameters = context.issue({
            body: result + explain
          });
          break;
        }
        case keywords?.whatTheyKnows?.toUpperCase() ?? "SOBREOQUESABEM": {
          const mostUsedTermsResult = await mostUsedTerms(knowledgeBase);

          const explain = getExplainWhatTheyKnows(explainLevel, mostUsedTermsResult);
          const result = messages[Question.WHAT_THEY_KNOWS](sender.login, mostUsedTermsResult.map(({ term }) => term).slice(0, 20));

          parameters = context.issue({
            body: result + explain
          });
          break;
        }
        default: {
          break;
        }
      }

      github.issues.createComment(parameters);
    }
  });
};
