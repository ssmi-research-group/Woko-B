import { Octokit } from '@octokit/rest';
import Webhooks from '@octokit/webhooks';

export interface Action {
  isMessageFromCreator: boolean;
  timestamp: number;
  text: string;
}

export interface Worker {
  id: number;
  name: string;
  actions: Action[];
}

export interface Links {
  [rel: string]: string;
}

export interface FrequencyOfTerms {
  [term: string]: number;
}

export interface TermAmount {
  term: string;
  amount: number;
}

export interface WorkerScore {
  worker: Worker;
  score: number;
}

export interface WorkersKnowledge {
  name: string;
  actions: {
    withTerm: number;
    total: number;
  };
}

export type User = Octokit.IssuesListForRepoResponseItemUser;

export interface Message {
  user: User;
  body: string;
  createdAt: string;
}

export interface Issue {
  user: User;
  messages: Message[];
}

export interface Identifiable {
  id: number;
}

export interface Request<M, O> {
  method: M;
  options: Octokit.RequestOptions & O;
}

export type ListForRepoParams = Octokit.IssuesListForRepoParams;
export type ListForRepoResponseItem = Octokit.IssuesListForRepoResponseItem;

export type ListCommentsParams = Octokit.IssuesListCommentsParams;
export type ListCommentsResponseItem = Octokit.IssuesListCommentsResponseItem;

export type RequestMethod<P, R extends Identifiable> = (
  params?: Octokit.RequestOptions & P
) => Promise<Octokit.Response<R[]>>;

export type Repository = Webhooks.PayloadRepository;

export enum Question {
  WHO_KNOWS = "whoKnows",
  HOW_MANY_KNOWS = "howManyKnows",
  WHAT_THEY_KNOWS = "whatTheyKnows"
}

export interface Messages {
  [Question.WHO_KNOWS]: (user: string, term: string, worker: string) => string;
  [Question.HOW_MANY_KNOWS]: (user: string, term: string, proportionOfKnowledge: number, levelOfSpecialization: number) => string;
  [Question.WHAT_THEY_KNOWS]: (user: string, terms: string[]) => string;
}

export interface Config {
  keywords?: {
    [question in Question]?: string;
  } & {
    explain: string;
  }
} 