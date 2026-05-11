-- Migration: add room_id to cards for agent-rooms integration
ALTER TABLE cards ADD COLUMN room_id TEXT;
CREATE INDEX cards_room_id_idx ON cards(room_id);
