const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

// --- Load and Parse Wordlists ---
function loadWordList(fileName) {
    try {
        const filePath = path.join(__dirname, fileName);
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        // Split by commas, newlines, or carriage returns and clean up entries
        return fileContent
            .split(/[\r\n,]+/)
            .map(word => word.trim().toUpperCase())
            .filter(word => word.length === 5);
    } catch (err) {
        console.error(`Failed to load ${fileName}:`, err.message);
        return [];
    }
}

const SOLUTION_WORDS = loadWordList('valid_solutions.csv');
const ACCEPTED_WORDS = loadWordList('valid_guesses.csv');

const VALID_GUESSES = new Set([...SOLUTION_WORDS, ...ACCEPTED_WORDS]);

console.log(`Loaded ${SOLUTION_WORDS.length} possible solutions and ${VALID_GUESSES.size} total valid guesses.`);

if (SOLUTION_WORDS.length === 0) {
    SOLUTION_WORDS.push('REACT', 'LINUX', 'BOARD', 'GAMES', 'MATCH', 'STACK', 'PROXY');
    SOLUTION_WORDS.forEach(w => VALID_GUESSES.add(w));
}

const rooms = {};
const socketMap = {};
function getRandomSolution() {
    return SOLUTION_WORDS[Math.floor(Math.random() * SOLUTION_WORDS.length)];
}

// --- Helper: Grade Guess ---
function gradeGuess(guess, secretWord) {
    const result = Array(5).fill('gray');
    const secretArr = secretWord.split('');
    const guessArr = guess.split('');

    for (let i = 0; i < 5; i++) {
        if (guessArr[i] === secretArr[i]) {
            result[i] = 'green'; secretArr[i] = null;
        }
    }
    for (let i = 0; i < 5; i++) {
        if (result[i] === 'gray') {
            const matchIndex = secretArr.indexOf(guessArr[i]);
            if (matchIndex !== -1) {
                result[i] = 'yellow'; secretArr[matchIndex] = null;
            }
        }
    }
    return result;
}

// --- WebSocket Logic ---
io.on('connection', (socket) => {
    console.log(`Socket ${socket.id.substring(0, 4)} connected`);

    // 1. Join/Create Room
    socket.on('join_room', (roomCode, playerName, sessionId) => {
        roomCode = roomCode.toUpperCase();
        playerName = playerName ? playerName.trim() : '';
        if (playerName && playerName.length > 1 && playerName.length < 11) {
            playerName = playerName.substring(0, 10);
        } else {
            playerName = `Guest-${sessionId.substring(0, 4)}`;
        }
        
        if (!rooms[roomCode]) {
            rooms[roomCode] = { secretWord: '', gameStarted: false, players: {}, scores: {} };
        }
        const room = rooms[roomCode];

        // Link this temporary socket to the permanent session
        socketMap[socket.id] = { roomCode, sessionId };
        socket.join(roomCode);

        // RECONNECTION LOGIC
        if (room.players[sessionId]) {
            console.log(`[${roomCode}] ${playerName} reconnected.`);
            room.players[sessionId].name = playerName; 
            
            const secureOpponents = {};
            if (room.gameStarted || room.secretWord) {
                const isFinished = room.players[sessionId].status !== 'playing';
                for (const oppId in room.players) {
                    if (oppId === sessionId) continue;
                    secureOpponents[oppId] = {
                        status: room.players[oppId].status,
                        guessesCount: room.players[oppId].guessesCount,
                        board: room.players[oppId].fullBoard.map(guessData => ({
                            colors: guessData.colors,
                            guess: (isFinished || room.players[oppId].status !== 'playing') ? guessData.guess : null
                        }))
                    };
                }
            }

            socket.emit('restore_state', {
                roomCode,
                players: Object.keys(room.players).map(id => ({ id, name: room.players[id].name })),
                gameStarted: room.gameStarted,
                myState: room.players[sessionId],
                scores: room.scores,
                secretWord: (!room.gameStarted) ? room.secretWord : null,
                opponents: secureOpponents
            });
            return;
        }

        // NEW PLAYER LOGIC
        if (Object.keys(room.players).length >= 3) {
            socket.emit('room_error', 'This room is already full!');
            return;
        }
        if (room.gameStarted) {
            socket.emit('room_error', 'Game has already started!');
            return;
        }

        room.players[sessionId] = { status: 'playing', guessesCount: 0, fullBoard: [], name: playerName };
        if (room.scores[sessionId] === undefined) room.scores[sessionId] = 0;

        io.to(roomCode).emit('room_updated', { 
            roomCode, 
            players: Object.keys(room.players).map(id => ({ id, name: room.players[id].name })) 
        });

        if (Object.keys(room.players).length === 3) {
            room.secretWord = getRandomSolution();
            room.gameStarted = true;
            console.log(`[${roomCode}] Started. Secret: ${room.secretWord}`);
            io.to(roomCode).emit('game_start', { players: Object.keys(room.players).map(id => ({ id, name: room.players[id].name })) });
        }
    });

    // 2. Handle Guesses and End-of-Round
    socket.on('submit_guess', (data) => {
        // Look up the session ID based on the socket that sent the request
        const { roomCode, sessionId } = socketMap[socket.id] || {};
        if (!roomCode || !sessionId) return;
        
        const room = rooms[roomCode];
        if (!room || !room.gameStarted || !room.players[sessionId]) return;
        const player = room.players[sessionId];

        if (player.status !== 'playing' || player.guessesCount >= 6) return;

        const cleanGuess = data.guess ? data.guess.trim().toUpperCase() : '';
        if (cleanGuess.length !== 5 || !VALID_GUESSES.has(cleanGuess)) {
            socket.emit('guess_error', 'Not in word list');
            return;
        }

        player.guessesCount++;
        const gradedColors = gradeGuess(cleanGuess, room.secretWord);
        player.fullBoard.push({ guess: cleanGuess, colors: gradedColors });

        socket.emit('guess_result', { guess: cleanGuess, colors: gradedColors, guessesCount: player.guessesCount });

        let newStatus = player.status;
        const isCorrect = gradedColors.every(c => c === 'green');
        
        if (isCorrect) {
            newStatus = 'won';
            room.scores[sessionId] += (7 - player.guessesCount); 
        } else if (player.guessesCount >= 6) {
            newStatus = 'lost';
        }
        player.status = newStatus;

        // TARGETED BROADCAST
        for (const oppSessionId in room.players) {
            if (oppSessionId === sessionId) continue; 
            
            // We must broadcast to the specific socket attached to this session
            // Find the socket ID that matches the opponent's session ID
            const oppSocketId = Object.keys(socketMap).find(key => socketMap[key].sessionId === oppSessionId);
            if (!oppSocketId) continue;

            const canSeeLetters = room.players[oppSessionId].status !== 'playing';

            io.to(oppSocketId).emit('opponent_update', { 
                playerId: sessionId, 
                colors: gradedColors,
                guessesCount: player.guessesCount,
                status: player.status,
                didWin: isCorrect,
                guess: canSeeLetters ? cleanGuess : null 
            });
        }

        if (newStatus !== 'playing') {
            const allOpponentsBoards = {};
            for (const oppSessionId in room.players) {
                if (oppSessionId === sessionId) continue;
                allOpponentsBoards[oppSessionId] = room.players[oppSessionId].fullBoard;
            }
            socket.emit('reveal_boards', allOpponentsBoards);
        }

        const allFinished = Object.values(room.players).every(p => p.status !== 'playing');
        if (allFinished) {
            console.log(`[${roomCode}] Round over. Word was: ${room.secretWord}`);
            room.gameStarted = false; 
            io.to(roomCode).emit('match_over', { secretWord: room.secretWord, scores: room.scores });
        }
    });

    // 3. Handle Next Round
    socket.on('next_round', (roomCode) => {
        const room = rooms[roomCode];
        if (!room || room.gameStarted) return;

        for (const playerId in room.players) {
            room.players[playerId].status = 'playing';
            room.players[playerId].guessesCount = 0;
            room.players[playerId].fullBoard = [];
        }

        room.secretWord = getRandomSolution();
        room.gameStarted = true;
        console.log(`[${roomCode}] Next round started. New Secret: ${room.secretWord}`);
        io.to(roomCode).emit('game_start', { players: Object.keys(room.players).map(id => ({ id, name: room.players[id].name })) });
    });

    // 4. Disconnect/Cleanup
    socket.on('disconnect', () => {
        const { roomCode, sessionId } = socketMap[socket.id] || {};
        delete socketMap[socket.id]; // Remove the mapping to prevent memory leaks
        
        if (roomCode && rooms[roomCode]) {
            console.log(`[${roomCode}] Session ${sessionId?.substring(0,4)} disconnected. Preserving state.`);
        }
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Backend Active: Port ${PORT}`));