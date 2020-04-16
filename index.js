'use strict'

module.exports = app => {
  class KnowledgeBase {
    constructor(github, repository) {
      this.workers = []

      return (async () => {
        const owner = repository.owner.login
        const repo = repository.name

        const issueNumbers = await github.issues
          .listForRepo({ owner, repo })
          .then(response => response.data.map(issue => issue.number))

        for (const issue_number of issueNumbers) {
          const comments = await github.issues
            .listComments({ owner, repo, issue_number })
            .then(response => response.data)

          for (const comment of comments) {
            const { user } = comment
            const { id } = user

            const worker = this.workers.find(worker => worker.id === id)

            const action = comment => ({
              text: comment.body,
              timestamp: +new Date(comment.created_at),
            })

            if (!worker)
              this.workers.push({
                id,
                name: user.login,
                actions: [action(comment)],
              })
            else worker.actions.push(action(comment))
          }
        }

        return this
      })()
    }

    getWorkerActionsWithTerm(worker, term) {
      const regex = new RegExp(`\\b${term}\\b`, 'i')
      return worker.actions.filter(action => regex.test(action.text))
    }

    getLowestActionTimestamp(term) {
      return Math.min(
        ...this.workers
          .flatMap(worker => this.getWorkerActionsWithTerm(worker, term))
          .map(action => action.timestamp)
      )
    }
  }

  function getCurrentTimestamp() {
    return +new Date()
  }

  function assignment(term, knowledgeBase) {
    const lowestActionTimestamp = knowledgeBase.getLowestActionTimestamp(term)
    const now = getCurrentTimestamp()

    let suitableWorkerScore = 0
    let suitableWorker = null

    for (const worker of knowledgeBase.workers) {
      const workerActionsWithTerm = knowledgeBase.getWorkerActionsWithTerm(worker, term)
      let score = 0

      for (const action of workerActionsWithTerm) {
        score += 1 - (now - action.timestamp) / (now - lowestActionTimestamp)
      }

      if (score > suitableWorkerScore) {
        suitableWorkerScore = score
        suitableWorker = worker
      }
    }

    return suitableWorker
  }

  function aggregation(term, knowledgeBase) {
    let workersWithKnowledge = 0
    let totalOfSpecialization = 0

    for (const worker of knowledgeBase.workers) {
      const workerActionsWithTerm = knowledgeBase.getWorkerActionsWithTerm(worker, term)

      if (!!workerActionsWithTerm.length) {
        ++workersWithKnowledge
        totalOfSpecialization += workerActionsWithTerm.length / worker.actions.length
      }
    }

    const proportionOfKnowledge = workersWithKnowledge / knowledgeBase.workers.length
    const levelOfSpecialization = totalOfSpecialization / knowledgeBase.workers.length

    return {
      proportionOfKnowledge,
      levelOfSpecialization,
    }
  }

  function toPercentage(number) {
    return (number * 100).toFixed(2)
  }

  app.on('issue_comment.created', async context => {
    const { github, payload } = context
    const { comment, sender, repository } = payload

    const question = /@suitablebot\s(?<algorithm>quem\ssabe|quantos\ssabem)\s"(?<term>.*)"/i.exec(comment.body)

    if (question) {
      const knowledgeBase = await new KnowledgeBase(github, repository)
      const {
        groups: { algorithm, term },
      } = question

      let parameters

      switch (algorithm.toUpperCase()) {
        case 'QUEM SABE': {
          const assignmentResult = assignment(term, knowledgeBase)
          parameters = context.issue({ body: `@${sender.login}, quem sabe é: @${assignmentResult.name}` })
          break
        }
        case 'QUANTOS SABEM': {
          const aggregationResult = aggregation(term, knowledgeBase)
          parameters = context.issue({
            body:
              `@${sender.login},<br>` +
              `Proporção: ${toPercentage(aggregationResult.proportionOfKnowledge)}%<br>` +
              `Especialização: ${toPercentage(aggregationResult.levelOfSpecialization)}%`,
          })
          break
        }
      }

      return github.issues.createComment(parameters)
    }
  })
}
