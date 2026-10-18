const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

const QUESTIONS = [
  { category:"LOCATION", q:"Where is Nova City located?", options:["Venus","Mars","Jupiter","Mercury"], correct:1, explain:"The poster places Nova City on Mars, protected by giant glass domes." },
  { category:"CITY DESIGN", q:"What protects Nova City from Mars's harsh environment?", options:["Underground rivers","Giant glass domes","A magnetic wall","Thick forests"], correct:1, explain:"Giant glass domes protect the city from the harsh Martian environment." },
  { category:"SCENERY", q:"Which landscape surrounds Nova City?", options:["Green tropical islands","Snowy pine forests","Red mountains and vast deserts","Deep oceans"], correct:2, explain:"The poster describes red mountains and vast deserts around the city." },
  { category:"CITY ZONES", q:"How many main zones does Nova City have?", options:["Three","Four","Five","Six"], correct:2, explain:"The five zones are Residential, Entertainment, Technology, Green, and Spaceport." },
  { category:"CITY ZONES", q:"Which zone contains AI research centers and advanced laboratories?", options:["Green Zone","Technology Zone","Spaceport Zone","Entertainment Zone"], correct:1, explain:"AI research centers and advanced laboratories are in the Technology Zone." },
  { category:"CITY ZONES", q:"Where would residents find artificial forests, lakes, and waterfalls?", options:["Green Zone","Residential Zone","Spaceport Zone","Technology Zone"], correct:0, explain:"The Green Zone brings nature into the city with forests, lakes, and waterfalls." },
  { category:"CITY SYSTEMS", q:"What is Nova City's main source of clean electricity in the poster?", options:["Coal and oil","Solar panels and advanced batteries","Wood-burning plants","Only imported electricity"], correct:1, explain:"Solar panels and advanced batteries provide clean, reliable electricity." },
  { category:"CITY SYSTEMS", q:"How do people travel quickly between city zones?", options:["Horse-drawn carriages","High-speed magnetic trains and transparent tunnels","Sailing boats","Conventional bicycles only"], correct:1, explain:"The city system includes high-speed magnetic trains and transparent tunnels." },
  { category:"POPULATION", q:"Approximately how many citizens will live in Nova City?", options:["10,000–15,000","100,000–150,000","1–1.5 million","10–15 million"], correct:3, explain:"The poster estimates a population of about 10 to 15 million." },
  { category:"ARCHITECTURE", q:"Why does Nova City use many giant skyscrapers?", options:["To block sunlight completely","To save space and protect the Martian environment","To make transport impossible","To avoid using technology"], correct:1, explain:"Vertical architecture saves space and helps keep the natural Mars environment safe." },
  { category:"TRANSPORT", q:"Which option is listed as a smart way to travel inside the domes?", options:["Self-driving cars and flying taxis","Steam trains","Animal-powered carts","Submarines"], correct:0, explain:"The poster lists self-driving cars and flying taxis as smart transit." },
  { category:"SPACE TRAVEL", q:"Which destination is mentioned for future space vacations?", options:["Earth, the Moon, and orbiting Space Hotels","The Sun's surface","The centre of Jupiter","Only the ocean floor"], correct:0, explain:"The poster mentions Earth, the Moon, and orbiting Space Hotels." },
  { category:"HOUSING", q:"How can people control lights in smart houses?", options:["Only with candles","By voice or phone","By opening a window","They cannot control them"], correct:1, explain:"Smart lights can be controlled by voice or phones." },
  { category:"GREEN BUILDINGS", q:"Which feature helps green buildings save resources?", options:["Water- and energy-saving systems","More disposable plastic","No natural light","Always-on heating"], correct:0, explain:"Green buildings use solar panels and water- and energy-saving systems." },
  { category:"SKYSCRAPERS", q:"What is the benefit of having apartments, offices, malls, and gyms in one building?", options:["People must travel farther","It reduces travel needs and saves land","It removes all public spaces","It increases traffic"], correct:1, explain:"A 'city in a building' lets people live, work, and relax in one place." },
  { category:"AI & ENERGY", q:"What does the Central AI Brain do?", options:["Paints every building","Optimizes energy distribution and stores extra power","Controls the weather on Earth","Replaces all citizens"], correct:1, explain:"The Central AI Brain optimizes grid distribution and stores extra energy." },
  { category:"AI & TRANSPORT", q:"How do smart signals help transport in Nova City?", options:["They create more traffic jams","They adjust in real time to reduce traffic jams","They stop all vehicles permanently","They only work at night"], correct:1, explain:"Smart signals adjust in real time to help eliminate traffic jams." },
  { category:"SAFETY", q:"What can smart sensors detect quickly?", options:["Only birthdays","Accidents, fires, or crimes","People's favourite films","Future exam questions"], correct:1, explain:"Smart sensors detect accidents, fires, or crimes and alert emergency services." },
  { category:"HEALTHCARE", q:"What can connected health devices do?", options:["Monitor health and dispatch medical assistance automatically","Guarantee nobody gets sick","Replace every hospital","Turn off the oxygen supply"], correct:0, explain:"Connected devices monitor personal health and can automatically dispatch medical assistance." },
  { category:"CHALLENGES", q:"What is one major challenge of building a huge city on Mars?", options:["Too much ocean water","Maintaining enough energy and a balanced environment","Too many natural forests","Having too much breathable air outside"], correct:1, explain:"The poster identifies energy demands and maintaining a balanced environment as major challenges." }
];

const rooms = new Map();
const codeChars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function makeCode() {
  let code;
  do { code = Array.from({length:5}, () => codeChars[Math.floor(Math.random()*codeChars.length)]).join(""); }
  while (rooms.has(code));
  return code;
}
function publicPlayers(room) {
  return [...room.players.values()].map(p => ({
    id:p.id, name:p.name, score:p.score, connected:p.connected,
    answered:!!p.answer, bet:p.bet || "x1"
  })).sort((a,b) => b.score-a.score || a.name.localeCompare(b.name));
}
function sendLobby(code) {
  const room = rooms.get(code);
  if (!room) return;
  io.to(code).emit("lobby", { code, players:publicPlayers(room), state:room.state, questionIndex:room.questionIndex });
}
function clearTimer(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
}
function questionPayload(room) {
  const q = QUESTIONS[room.questionIndex];
  return {
    index:room.questionIndex, total:QUESTIONS.length, category:q.category, q:q.q,
    options:q.options, duration:room.duration, deadline:room.deadline,
    players:publicPlayers(room)
  };
}
function finishQuestion(code) {
  const room = rooms.get(code);
  if (!room || room.state !== "question") return;
  clearTimer(room);
  const q = QUESTIONS[room.questionIndex];
  const counts = [0,0,0,0];
  let correctCount = 0;
  for (const p of room.players.values()) {
    if (!p.answer) continue;
    counts[p.answer.choice]++;
    const correct = p.answer.choice === q.correct;
    if (correct) {
      correctCount++;
      const base = 1000;
      const multiplier = p.answer.bet === "x2" ? 2 : p.answer.bet === "x3" ? 3 : p.answer.bet === "allin" ? 2 : 1;
      p.score += base * multiplier;
    } else if (p.answer.bet === "allin") {
      p.score = 0;
    }
  }
  room.state = "results";
  room.deadline = null;
  room.result = {
    index:room.questionIndex, correct:q.correct, counts, correctCount,
    totalPlayers:room.players.size, explain:q.explain,
    leaderboard:publicPlayers(room)
  };
  io.to(code).emit("results", room.result);
  sendLobby(code);
}
io.on("connection", socket => {
  socket.on("createRoom", ({name, duration} = {}, cb = () => {}) => {
    const code = makeCode();
    const hostName = String(name || "Host").trim().slice(0,24) || "Host";
    const room = {
      code, hostId:socket.id, hostName, players:new Map(), state:"lobby",
      questionIndex:-1, duration:[10,15,20,30].includes(Number(duration)) ? Number(duration) : 15,
      deadline:null, timer:null, result:null
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.role = "host";
    cb({ok:true, code, hostName, duration:room.duration});
    sendLobby(code);
  });
  socket.on("joinRoom", ({code, name} = {}, cb = () => {}) => {
    code = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,5);
    const room = rooms.get(code);
    if (!room) return cb({ok:false, error:"Room not found. Check the code and try again."});
    if (room.state !== "lobby") return cb({ok:false, error:"This game has already started."});
    if (room.players.size >= 100) return cb({ok:false, error:"This room is full."});
    const playerName = String(name || "").trim().slice(0,24);
    if (!playerName) return cb({ok:false, error:"Enter a nickname first."});
    const duplicate = [...room.players.values()].some(p => p.name.toLowerCase() === playerName.toLowerCase());
    if (duplicate) return cb({ok:false, error:"That nickname is already taken in this room."});
    room.players.set(socket.id, {id:socket.id, name:playerName, score:0, connected:true, answer:null, bet:"x1"});
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.role = "player";
    cb({ok:true, code, name:playerName});
    sendLobby(code);
  });
  socket.on("startQuestion", (_, cb = () => {}) => {
    const code = socket.data.roomCode, room = rooms.get(code);
    if (!room || socket.data.role !== "host" || room.hostId !== socket.id) return cb({ok:false,error:"Host only."});
    if (room.state === "question") return cb({ok:false,error:"A question is already running."});
    if (room.questionIndex + 1 >= QUESTIONS.length) return cb({ok:false,error:"Game is over."});
    room.questionIndex++;
    room.state = "question";
    room.result = null;
    room.deadline = Date.now() + room.duration * 1000;
    for (const p of room.players.values()) { p.answer = null; p.bet = "x1"; }
    io.to(code).emit("question", questionPayload(room));
    clearTimer(room);
    room.timer = setTimeout(() => finishQuestion(code), room.duration * 1000);
    cb({ok:true});
    sendLobby(code);
  });
  socket.on("submitAnswer", ({choice, bet} = {}, cb = () => {}) => {
    const code = socket.data.roomCode, room = rooms.get(code);
    const p = room && room.players.get(socket.id);
    if (!room || !p || room.state !== "question") return cb({ok:false,error:"No question is accepting answers."});
    if (Date.now() >= room.deadline) return cb({ok:false,error:"Time is up."});
    if (p.answer) return cb({ok:false,error:"Your answer is already locked."});
    choice = Number(choice);
    if (![0,1,2,3].includes(choice)) return cb({ok:false,error:"Invalid answer."});
    bet = ["x1","x2","x3","allin"].includes(bet) ? bet : "x1";
    p.bet = bet;
    p.answer = {choice, bet, at:Date.now()};
    cb({ok:true});
    io.to(code).emit("answerProgress", {answered:[...room.players.values()].filter(x=>x.answer).length, total:room.players.size});
    sendLobby(code);
  });
  socket.on("endQuestion", (_, cb = () => {}) => {
    const code = socket.data.roomCode, room = rooms.get(code);
    if (!room || socket.data.role !== "host" || room.hostId !== socket.id) return cb({ok:false,error:"Host only."});
    if (room.state !== "question") return cb({ok:false,error:"No active question."});
    finishQuestion(code); cb({ok:true});
  });
  socket.on("getState", (_, cb = () => {}) => {
    const code = socket.data.roomCode, room = rooms.get(code);
    if (!room) return cb({ok:false});
    cb({ok:true, role:socket.data.role, code, hostName:room.hostName, state:room.state,
      duration:room.duration, questionIndex:room.questionIndex, players:publicPlayers(room),
      question:room.state==="question" ? questionPayload(room) : null, result:room.result,
      answered:room.players.size ? [...room.players.values()].filter(p=>p.answer).length : 0});
  });
  socket.on("disconnect", () => {
    const code = socket.data.roomCode, room = rooms.get(code);
    if (!room) return;
    if (socket.data.role === "host" && room.hostId === socket.id) {
      clearTimer(room);
      io.to(code).emit("roomClosed", "The host has left the room.");
      rooms.delete(code);
      return;
    }
    const p = room.players.get(socket.id);
    if (p) {
      room.players.delete(socket.id);
      sendLobby(code);
      if (room.state === "question" && room.players.size && [...room.players.values()].every(x=>x.answer)) finishQuestion(code);
    }
  });
});

server.listen(PORT, () => console.log(`Nova City Quiz running on port ${PORT}`));
