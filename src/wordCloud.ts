import * as d3 from "d3";
import Canvas from "canvas";
import cloud from "d3-cloud";
import { JSDOM } from "jsdom";

export default async function wordCloud(terms: string[]) {
  const { document } = new JSDOM().window;

  const frame = {
    width: 1000,
    height: 1000,
  };

  const words = terms.map((text, index, { length }) => ({
    text,
    size: 20 + 5 * (length - index),
  }));

  const svg = d3
    .select(document.body)
    .append("svg")
    .attr("width", frame.width)
    .attr("height", frame.height)
    .attr("xmlns", "http://www.w3.org/2000/svg")
    .append("g")
    .attr("transform", `translate(${frame.width / 2}, ${frame.height / 2})`);

  return new Promise<string>((resolve) => {
    cloud()
      .size([frame.width, frame.height])
      .canvas(() => (Canvas.createCanvas(1, 1) as unknown) as HTMLCanvasElement)
      .words(words)
      .padding(5)
      .rotate(0)
      .font("Impact")
      .fontSize((d: cloud.Word) => d.size ?? 20)
      .on("end", draw)
      .start();

    function draw(words: cloud.Word[]) {
      const fill = d3.schemePaired;

      // @ts-ignore
      const cloud = svg
        .selectAll("g text")
        .data(words, (d: cloud.Word) => d.text);

      cloud
        .enter()
        .append("text")
        .text((d: cloud.Word) => d.text)
        .attr("font-size", (d: cloud.Word) => d.size)
        .attr("font-family", (d: cloud.Word) => d.font)
        .attr("padding", (d: cloud.Word) => d.padding)
        .attr("fill", (_d: cloud.Word, i: number) => fill[i % fill.length])
        .attr("text-anchor", "middle")
        .attr("x", (d: cloud.Word) => d.x)
        .attr("y", (d: cloud.Word) => d.y);

      resolve(d3.select(document.body).html());
    }
  });
}
