# Woko-B

## Overview do projeto

Woko-B é um robô social criado com o [Probot](https://probot.github.io).
Ele foi desenvolvido como um estudo de caso sobre desenvolvimento de componentes de software associados a computação por humanos.
O estudo é parte do projeto PIBIC-CNPq coordenado pelo prof. Lesandro Ponciano e conduzido pelo aluno bolsista Gabriel Moreira Chaves, no curso Bacharelado em Engenharia de Software da Pontifícia Universidade Católica de Minas Gerais.

De forma geral, o robô possui três funcionalidades que podem ser acionadas pelos usuários: atribuição, agregação e frequência.
Pela funcionalidade de atribuição, o usuário informa um termo e o robô responde ao usuário quem entre os participantes das issues do repositório no qual o robô foi mencionado mais fala sobre aquele termo.
Pela funcionalidade de agregação, o usuário informa um termo e o robô responde ao usuário quantos participantes do repositório no qual o robô foi mencionado mais fala sobre aquele termo.
Pela funcionalidade de frequência, o robô retorna os termos mais usados pelos participantes das issues do repositório no qual o robô foi mencionado.

Para adicionar o robô ao seu repositório, instale-o a partir do link: [Woko-B App](https://github.com/apps/Woko-B).

### Projetos anteriores

Este projeto é a continuação de projetos anteriores desenvolvidos no [grupo de pesquisa](https://github.com/ssmi-research-group), os projetos estão listados a seguir:

- [arthursoas/WhoKnowsBot](https://github.com/arthursoas/WhoKnowsBot)
- [EricRibeiro/WhoKnowsBot](https://github.com/EricRibeiro/WhoKnowsBot)
- [ssmi-research-group/twitterCollaborativeBot](https://github.com/arthursoas/WhoKnowsBot)

Como pode ser observado, esses projetos funcionavam no ambiente do Twitter, enquanto este projeto no ambiente GitHub.

## Como utilizar

- Atribuição: `@Woko-B QuemSabe <Termo>`
- Agregação: `@Woko-B QuantoSsabem <Termo>`
- Frequência: `@Woko-B OQueSabem`

Observação: A interpretação da mensagem informada ao robô é insensível a maiúsculas.

## Como funciona

O Woko-B ao ser instalado nos repositórios, possui acesso aos issues e aos seus comentários.
Quando um comentário em uma issue é criado, o robô é notificado pelo GitHub, enviando as informações do comentário realizado.
Com base nos dados recebidos, o robô analisa e identifica se ele se trata de uma comando ao robô.
A partir disso ele executa o que foi solicitado e retorna os resultados obtidos por meio de um comentário na issue no qual ele foi mencionado e realiza a menção de quem solicitou a tarefa o robô.

## Base de conhecimento

Antes da realização do comando solicitado, o robô monta a sua base de conhecimento, para isso ele solicita as informações de todas as issues do repositório no qual ele foi mencionado e coleta todos os comentários e o corpo da mensagem das issues. Com isso ele constrói a sua base de conhecimento, no qual o seu esquema está informado abaixo:

```typescript
interface Action {
  isMessageFromCreator: boolean;
  timestamp: number;
  text: string;
}

interface Worker {
  id: number;
  name: string;
  actions: Action[];
}

interface KnowledgeBase {
  workers: Worker[];
}
```

## Quem sabe

Para determinar quem é usuário que mais sabe sobre um termo, o algoritmo usa essa fórmula:

<img alt="Fórmula" src="https://latex.codecogs.com/svg.latex?P_{w}%20=%20\sum_{a%20\in%20actions}%20\left(%201%20-%20\frac{now%20-%20T_{w,%20a}}{now%20-%20min(T^*)}%20+%20\begin{cases}0.5%20&%20w%20\in%20wc%20\\%200%20&%20w%20\in%20wc\end{cases}%20\right)">

- P <sub>w</sub> é pontuação do trabalhador w
- a é ação do trabalhador w
- T<sub>w,a</sub> é o timestamp da ação a
- T<sup>*</sup> é o timestamp da ação mais antiga
- wc é o trabalhador que criou a issue
- now é timestamp no momento da decisão de escalonamento (horário do sistema).

## Quantos sabem

Para determinar a proporção de quantos sabem e a especialização, o algoritmo usa essas fórmulas:

<img alt="Fórmula" src="https://latex.codecogs.com/svg.latex?awt%28w%2C%20t%29%20%3D%20%5C%7Ba%20%5Cmid%20a%20%5Cin%20w.a%20%5Cmid%20ts%20%5Cin%20a.m%20%5Cmid%20t%20%5Cin%20ts%5C%7D%20%5C%5C%20pok%20%3D%20%5Cfrac%7B%5Csum_%7Bw%20%5Cin%20ws%7D%20%5Cleft%28%5Cbegin%7Bcases%7D%7Cawt%28w%2Ct%29%7C%20%3E%200%20%26%201%5C%5C%7Cawt%28w%2Ct%29%7C%20%3D%200%20%26%200%20%5Cend%7Bcases%7D%5Cright%29%7D%7B%7Cws%7C%7D%20%5C%5C%20los%20%3D%20%5Cfrac%7B%5Csum_%7Bw%20%5Cin%20ws%7D%20%5Cleft%28%5Cbegin%7Bcases%7D%7Cawt%28w%2Ct%29%7C%20%3E%200%20%26%20%5Cfrac%7B%7Cawt%28w%2Ct%29%7C%7D%7B%7C%5C%7Ba%20%5Cmid%20a%20%5Cin%20w.a%5C%7D%7C%7D%20%5C%5C%20%7Cawt%28w%2Ct%29%7C%20%3D%200%20%26%200%20%5Cend%7Bcases%7D%5Cright%29%7D%7B%7Cws%7C%7D">
